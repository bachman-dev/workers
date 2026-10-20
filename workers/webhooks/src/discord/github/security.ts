import type { GithubWebhookPayload } from "../../types/github.ts";
import { escapeMarkdown } from "../markdown.ts";
import { type GithubMessage, markdownLink } from "../message.ts";
import { EXCERPT_LENGTH, assigneeLine, code, commitLink, formatBody, humanize, repositoryUrl } from "./util.ts";

type SecretScanningAlert = GithubWebhookPayload<"secret_scanning_alert">["alert"];

function secretScanningAlertSubject(alert: SecretScanningAlert): string {
  const name = alert.secret_type_display_name ?? alert.secret_type ?? "Secret";
  return `**${markdownLink(typeof alert.number === "number" ? `#${alert.number} ${name}` : name, alert.html_url)}**`;
}

export function repositoryAdvisoryMessage(
  payload: GithubWebhookPayload<"repository_advisory">,
): GithubMessage | undefined {
  const { repository, repository_advisory: advisory, sender } = payload;
  const message = {
    subject: `**${markdownLink(advisory.summary, advisory.html_url)}**`,
    sender,
    body: [formatBody(advisory.description, EXCERPT_LENGTH)],
    details: [
      code(advisory.ghsa_id),
      typeof advisory.cve_id === "string" ? code(advisory.cve_id) : undefined,
      advisory.severity === null ? undefined : `${humanize(advisory.severity)} severity`,
    ],
    repository,
    link: { label: "View advisory", url: advisory.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "published":
      return { ...message, status: "Success", title: "Security advisory published" };
    case "reported":
      return { ...message, status: "Attention", title: "Security vulnerability reported" };
    default:
      return undefined;
  }
}

export function repositoryVulnerabilityAlertMessage(
  payload: GithubWebhookPayload<"repository_vulnerability_alert">,
): GithubMessage | undefined {
  const { alert, repository, sender } = payload;
  const message = {
    subject: `**${escapeMarkdown(alert.affected_package_name)}** ${code(alert.affected_range)}`,
    sender,
    details: [
      markdownLink(alert.ghsa_id, `https://github.com/advisories/${alert.ghsa_id}`),
      `${humanize(alert.severity)} severity`,
      typeof alert.fixed_in === "string" ? `fixed in ${code(alert.fixed_in)}` : undefined,
    ],
    repository,
    link: { label: "View alert", url: repositoryUrl(repository, "security", "dependabot", String(alert.number)) },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "create":
      return { ...message, status: "Attention", title: "Vulnerable dependency detected" };
    case "resolve":
      return { ...message, status: "Success", title: "Vulnerability alert resolved" };
    case "dismiss": {
      const reason = payload.alert.dismiss_reason;
      return {
        ...message,
        status: "Draft",
        title: "Vulnerability alert dismissed",
        body: [typeof reason === "string" ? `Dismissed as ${escapeMarkdown(reason)}` : undefined],
      };
    }
    default:
      return undefined;
  }
}

export function secretScanningAlertMessage(
  payload: GithubWebhookPayload<"secret_scanning_alert">,
): GithubMessage | undefined {
  const { alert, repository, sender } = payload;
  const message = {
    subject: secretScanningAlertSubject(alert),
    sender,
    details: [
      alert.validity === undefined || alert.validity === "unknown" ? undefined : `${alert.validity} secret`,
      alert.publicly_leaked === true ? "publicly leaked" : undefined,
    ],
    repository,
    link: typeof alert.html_url === "string" ? { label: "View alert", url: alert.html_url } : undefined,
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "created":
      return { ...message, status: "Attention", title: "Secret detected" };
    case "reopened":
      return { ...message, status: "Attention", title: "Secret scanning alert reopened" };
    case "resolved": {
      const { resolution, resolution_comment: comment } = alert;
      return {
        ...message,
        status: "Success",
        title: "Secret scanning alert resolved",
        body: [
          typeof resolution === "string" ? `Resolved as ${humanize(resolution)}` : undefined,
          formatBody(comment, EXCERPT_LENGTH),
        ],
      };
    }
    case "assigned":
      return {
        ...message,
        status: "Attention",
        title: "Secret scanning alert assigned",
        body: [assigneeLine("Assigned to", payload.assignee)],
      };
    case "unassigned":
      return {
        ...message,
        status: "Info",
        title: "Secret scanning alert unassigned",
        body: [assigneeLine("Unassigned", payload.assignee)],
      };
    default:
      return undefined;
  }
}

export function secretScanningAlertLocationMessage(
  payload: GithubWebhookPayload<"secret_scanning_alert_location">,
): GithubMessage {
  const { alert, location, repository, sender } = payload;
  const { details } = location;
  let where: string | undefined;
  let url = details !== undefined && "html_url" in details ? details.html_url : alert.html_url;
  if (details !== undefined && "commit_sha" in details && "path" in details) {
    const lines =
      details.start_line === details.end_line
        ? `L${details.start_line}`
        : `L${details.start_line}-L${details.end_line}`;
    url = `${repositoryUrl(repository, "blob", details.commit_sha, details.path)}#${lines}`;
    where = `${code(details.path)} in ${commitLink(repository, details.commit_sha)}`;
  } else if (location.type !== undefined) {
    where = `In ${humanize(location.type)}`;
  }
  return {
    status: "Attention",
    title: "Secret found in a new location",
    subject: secretScanningAlertSubject(alert),
    sender,
    body: [where],
    repository,
    link: typeof url === "string" ? { label: "View location", url } : undefined,
  };
}
