import type { GithubWebhookPayload } from "../../types/github.ts";
import { escapeMarkdown, firstLine } from "../markdown.ts";
import { type GithubMessage, type MessageStatus, markdownLink } from "../message.ts";
import { EXCERPT_LENGTH, code, commitLink, formatBody, refLink, repositoryUrl } from "./util.ts";

const MAX_LISTED_COMMITS = 5;
const MAX_COMMIT_MESSAGE_LENGTH = 100;

type CheckRunConclusion = Extract<
  GithubWebhookPayload<"check_run">,
  { action: "completed" }
>["check_run"]["conclusion"];

const conclusions: Record<NonNullable<CheckRunConclusion>, { status: MessageStatus; title: string }> = {
  success: { status: "Success", title: "Check run succeeded" },
  failure: { status: "Failure", title: "Check run failed" },
  timed_out: { status: "Failure", title: "Check run timed out" },
  startup_failure: { status: "Failure", title: "Check run failed to start" },
  action_required: { status: "Attention", title: "Check run needs action" },
  cancelled: { status: "Draft", title: "Check run canceled" },
  skipped: { status: "Draft", title: "Check run skipped" },
  stale: { status: "Draft", title: "Check run went stale" },
  neutral: { status: "Draft", title: "Check run completed" },
  waiting: { status: "Draft", title: "Check run waiting" },
  pending: { status: "Draft", title: "Check run pending" },
};

export function commitCommentMessage(payload: GithubWebhookPayload<"commit_comment">): GithubMessage {
  const { comment, repository, sender } = payload;
  const { path, line } = comment;
  return {
    status: "Info",
    title: "New commit comment",
    subject: `On commit ${commitLink(repository, comment.commit_id)}`,
    sender,
    body: [formatBody(comment.body)],
    details: [typeof path === "string" ? code(typeof line === "number" ? `${path}:${line}` : path) : undefined],
    repository,
    link: { label: "View comment", url: comment.html_url },
  };
}

export function pushMessage(payload: GithubWebhookPayload<"push">): GithubMessage | undefined {
  const { commits, repository, sender } = payload;
  const isTag = payload.ref.startsWith("refs/tags/");
  const name = payload.ref.replace(/^refs\/(?:heads|tags)\//v, "");

  // Branches come and go all the time, e.g. for pull requests and the merge queue, so only pushes to existing branches
  // are posted
  if (!isTag && (payload.created || payload.deleted)) {
    return undefined;
  }
  if (payload.deleted) {
    return {
      status: "Failure",
      title: "Tag deleted",
      subject: code(name),
      sender,
      details: [`was ${commitLink(repository, payload.before)}`],
      repository,
    };
  }
  if (payload.created) {
    return {
      status: "Info",
      title: "Tag created",
      subject: refLink(repository, name),
      sender,
      details: [commitLink(repository, payload.after)],
      repository,
      link: { label: "View tag", url: payload.compare },
    };
  }

  // A push can move a branch to commits it already had, e.g. a force-push back to an earlier commit
  const commitCount = commits.length === 0 ? "" : ` ${commits.length} commit${commits.length === 1 ? "" : "s"}`;
  const listed = commits
    .slice(-MAX_LISTED_COMMITS)
    .map(
      (commit) =>
        `- ${commitLink(repository, commit.id, commit.url)} ${escapeMarkdown(firstLine(commit.message, MAX_COMMIT_MESSAGE_LENGTH))}`,
    );
  const unlisted = commits.length - listed.length;
  return {
    status: "Info",
    title: payload.forced ? `Force-pushed${commitCount}` : `Pushed${commitCount}`,
    subject: `to ${refLink(repository, name)}`,
    sender,
    body: [
      [unlisted > 0 ? `-# ${unlisted} earlier commit${unlisted === 1 ? "" : "s"} not shown` : undefined, ...listed]
        .filter((line) => line !== undefined)
        .join("\n"),
    ],
    repository,
    link: { label: "View changes", url: payload.compare },
  };
}

export function checkRunMessage(payload: GithubWebhookPayload<"check_run">): GithubMessage | undefined {
  if (payload.action !== "completed") {
    return undefined;
  }
  const { check_run: checkRun, repository, sender } = payload;
  const { status, title } =
    checkRun.conclusion === null
      ? { status: "Draft" as const, title: "Check run completed" }
      : conclusions[checkRun.conclusion];
  const appName = checkRun.app?.name;
  const outputTitle = checkRun.output.title;
  const branch = checkRun.check_suite.head_branch;
  return {
    status,
    title,
    subject: `**${markdownLink(checkRun.name, checkRun.html_url)}**${typeof appName === "string" ? ` from ${escapeMarkdown(appName)}` : ""}`,
    sender,
    body: [
      [
        typeof outputTitle === "string" && outputTitle !== "" ? `**${escapeMarkdown(outputTitle)}**` : undefined,
        formatBody(checkRun.output.summary, EXCERPT_LENGTH),
      ]
        .filter((section) => section !== undefined)
        .join("\n"),
    ],
    details: [
      typeof branch === "string" ? code(branch) : undefined,
      commitLink(repository, checkRun.head_sha),
      ...checkRun.pull_requests.map((pullRequest) =>
        markdownLink(`#${pullRequest.number}`, repositoryUrl(repository, "pull", String(pullRequest.number))),
      ),
    ],
    repository,
    link: { label: "Details", url: checkRun.details_url || checkRun.html_url },
  };
}
