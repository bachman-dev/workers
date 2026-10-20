import type { GithubWebhookPayload } from "../../types/github.ts";
import { escapeMarkdown } from "../markdown.ts";
import { type GithubMessage, markdownLink, userLink } from "../message.ts";
import { code, formatBody, humanize, repositoryUrl } from "./util.ts";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function pingMessage(payload: GithubWebhookPayload<"ping">): GithubMessage {
  const { hook, repository, sender, zen } = payload;
  return {
    status: "Info",
    title: "Webhook ping",
    subject: typeof zen === "string" ? `*${escapeMarkdown(zen)}*` : undefined,
    sender,
    details: [hook === undefined ? undefined : `Hook ${code(String(hook.id))}`],
    repository,
  };
}

export function repositoryMessage(payload: GithubWebhookPayload<"repository">): GithubMessage | undefined {
  const { repository, sender } = payload;
  const message = {
    sender,
    repository,
    link: { label: "View repository", url: repository.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "created":
      return {
        ...message,
        status: "Info",
        title: "Repository created",
        body: [typeof repository.description === "string" ? escapeMarkdown(repository.description) : undefined],
      };
    case "deleted":
      return { ...message, status: "Failure", title: "Repository deleted", link: undefined };
    case "archived":
      return { ...message, status: "Draft", title: "Repository archived" };
    case "unarchived":
      return { ...message, status: "Info", title: "Repository unarchived" };
    case "privatized":
      return { ...message, status: "Info", title: "Repository made private" };
    case "publicized":
      return { ...message, status: "Info", title: "Repository made public" };
    case "edited":
      return {
        ...message,
        status: "Info",
        title: "Repository edited",
        body: [`Changed ${Object.keys(payload.changes).map(humanize).join(", ")}`],
      };
    case "renamed":
      return {
        ...message,
        status: "Info",
        title: "Repository renamed",
        body: [`Renamed from ${code(payload.changes.repository.name.from)}`],
      };
    case "transferred": {
      const { organization, user } = payload.changes.owner.from;
      const previousOwner = organization ?? user;
      return {
        ...message,
        status: "Info",
        title: "Repository transferred",
        body: [
          previousOwner === undefined || previousOwner === null
            ? undefined
            : `Transferred from ${userLink(previousOwner)}`,
        ],
      };
    }
    default:
      return undefined;
  }
}

export function forkMessage(payload: GithubWebhookPayload<"fork">): GithubMessage {
  const { forkee, repository, sender } = payload;
  return {
    status: "Info",
    title: "Repository forked",
    subject: markdownLink(forkee.full_name, forkee.html_url),
    sender,
    details: [plural(repository.forks_count, "fork")],
    repository,
    link: { label: "View fork", url: forkee.html_url },
  };
}

export function watchMessage(payload: GithubWebhookPayload<"watch">): GithubMessage {
  const { repository, sender } = payload;
  return {
    status: "Info",
    title: "Repository starred",
    sender,
    details: [plural(repository.stargazers_count, "star")],
    repository,
    link: { label: "View stargazers", url: repositoryUrl(repository, "stargazers") },
  };
}

export function memberMessage(payload: GithubWebhookPayload<"member">): GithubMessage | undefined {
  const { member, repository, sender } = payload;
  const message = {
    status: "Attention",
    subject: member === null ? undefined : userLink(member),
    sender,
    repository,
    link: { label: "Manage access", url: repositoryUrl(repository, "settings", "access") },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "added": {
      const permission = payload.changes?.permission?.to;
      return {
        ...message,
        title: "Collaborator added",
        details: [typeof permission === "string" ? `${humanize(permission)} access` : undefined],
      };
    }
    case "removed":
      return { ...message, title: "Collaborator removed" };
    default:
      return undefined;
  }
}

export function releaseMessage(payload: GithubWebhookPayload<"release">): GithubMessage | undefined {
  const { release, repository, sender } = payload;
  const kind = release.prerelease ? "Pre-release" : "Release";
  const message = {
    subject: `**${markdownLink(release.name ?? release.tag_name, release.html_url)}**`,
    sender,
    details: [code(release.tag_name)],
    repository,
    link: { label: "View release", url: release.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "created":
      // Releases that aren't drafts are also published, which is reported instead
      return release.draft
        ? {
            ...message,
            status: "Draft",
            title: `Draft ${kind.toLowerCase()} created`,
            body: [formatBody(release.body)],
          }
        : undefined;
    case "published":
      return { ...message, status: "Success", title: `${kind} published`, body: [formatBody(release.body)] };
    case "unpublished":
      return { ...message, status: "Draft", title: `${kind} unpublished` };
    case "deleted":
      return { ...message, status: "Failure", title: `${kind} deleted`, link: undefined };
    default:
      return undefined;
  }
}

export function repositoryImportMessage(payload: GithubWebhookPayload<"repository_import">): GithubMessage {
  const { repository, sender } = payload;
  const message = {
    sender,
    repository,
    link: { label: "View repository", url: repository.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.status) {
    case "success":
      return { ...message, status: "Success", title: "Repository import succeeded" };
    case "failure":
      return { ...message, status: "Failure", title: "Repository import failed" };
    default:
      return { ...message, status: "Draft", title: "Repository import canceled" };
  }
}
