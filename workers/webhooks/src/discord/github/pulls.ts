import type { GithubWebhookPayload } from "../../types/github.ts";
import { type GithubMessage, userLink } from "../message.ts";
import { EXCERPT_LENGTH, assigneeLine, code, formatBody, humanize, issueLink } from "./util.ts";

function branches(
  pullRequest: { base: { ref: string }; head: { label: string | null; ref: string } },
  sameRepository: boolean,
): string {
  // Branches from forks are labeled with their owner, e.g. `octocat:main`
  const head = sameRepository ? pullRequest.head.ref : (pullRequest.head.label ?? pullRequest.head.ref);
  return `${code(head)} → ${code(pullRequest.base.ref)}`;
}

export function pullRequestMessage(payload: GithubWebhookPayload<"pull_request">): GithubMessage | undefined {
  const { pull_request: pullRequest, repository, sender } = payload;
  const message = {
    subject: issueLink(pullRequest),
    sender,
    details: [branches(pullRequest, pullRequest.head.repo?.id === repository.id)],
    repository,
    link: { label: "View pull request", url: pullRequest.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "opened":
      return pullRequest.draft === true
        ? { ...message, status: "Draft", title: "Draft pull request opened", body: [formatBody(pullRequest.body)] }
        : { ...message, status: "Info", title: "Pull request opened", body: [formatBody(pullRequest.body)] };
    case "closed":
      return pullRequest.merged === true
        ? { ...message, status: "Success", title: "Pull request merged" }
        : { ...message, status: "Failure", title: "Pull request closed" };
    case "reopened":
      return { ...message, status: "Info", title: "Pull request reopened" };
    case "converted_to_draft":
      return { ...message, status: "Draft", title: "Pull request converted to draft" };
    case "ready_for_review":
      return { ...message, status: "Info", title: "Pull request ready for review" };
    case "assigned":
      return {
        ...message,
        status: "Attention",
        title: "Pull request assigned",
        body: [assigneeLine("Assigned to", payload.assignee)],
      };
    case "unassigned":
      return {
        ...message,
        status: "Info",
        title: "Pull request unassigned",
        body: [assigneeLine("Unassigned", payload.assignee)],
      };
    case "locked": {
      const reason = pullRequest.active_lock_reason;
      return {
        ...message,
        status: "Draft",
        title: typeof reason === "string" ? `Pull request locked as ${humanize(reason)}` : "Pull request locked",
      };
    }
    case "unlocked":
      return { ...message, status: "Info", title: "Pull request unlocked" };
    default:
      return undefined;
  }
}

export function pullRequestReviewMessage(
  payload: GithubWebhookPayload<"pull_request_review">,
): GithubMessage | undefined {
  const { pull_request: pullRequest, repository, review, sender } = payload;
  const message = {
    subject: `On ${issueLink(pullRequest)}`,
    sender,
    body: [formatBody(review.body)],
    repository,
    link: { label: "View review", url: review.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "submitted":
      switch (review.state.toLowerCase()) {
        case "approved":
          return { ...message, status: "Success", title: "Pull request approved" };
        case "changes_requested":
          return { ...message, status: "Failure", title: "Changes requested" };
        default:
          // A single review comment also submits a review with no body; the review comment event already covers it
          return review.body === null || review.body.trim() === ""
            ? undefined
            : { ...message, status: "Info", title: "Pull request reviewed" };
      }
    case "dismissed":
      return { ...message, status: "Draft", title: "Review dismissed", body: [] };
    default:
      return undefined;
  }
}

export function pullRequestReviewCommentMessage(
  payload: GithubWebhookPayload<"pull_request_review_comment">,
): GithubMessage | undefined {
  const { comment, pull_request: pullRequest, repository, sender } = payload;
  const location = typeof comment.line === "number" ? `${comment.path}:${comment.line}` : comment.path;
  switch (payload.action) {
    case "created":
      return {
        status: "Info",
        title: comment.in_reply_to_id === undefined ? "New review comment" : "New review reply",
        subject: `On ${issueLink(pullRequest)}`,
        sender,
        body: [formatBody(comment.body)],
        details: [code(location)],
        repository,
        link: { label: "View comment", url: comment.html_url },
      };
    case "deleted":
      return {
        status: "Failure",
        title: "Review comment deleted",
        subject: `On ${issueLink(pullRequest)}`,
        sender,
        body: [formatBody(comment.body, EXCERPT_LENGTH)],
        details: [code(location)],
        repository,
        link: { label: "View pull request", url: pullRequest.html_url },
      };
    default:
      return undefined;
  }
}

export function pullRequestReviewThreadMessage(
  payload: GithubWebhookPayload<"pull_request_review_thread">,
): GithubMessage | undefined {
  const { pull_request: pullRequest, repository, sender, thread } = payload;
  const [comment] = thread.comments;
  const message = {
    subject: `On ${issueLink(pullRequest)}`,
    sender,
    body: [
      comment === undefined
        ? undefined
        : [
            comment.user === null ? undefined : `**${userLink(comment.user)} wrote:**`,
            formatBody(comment.body, EXCERPT_LENGTH),
          ]
            .filter((section) => section !== undefined)
            .join("\n"),
    ],
    details: comment === undefined ? [] : [code(comment.path)],
    repository,
    link: { label: "View thread", url: comment?.html_url ?? pullRequest.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "resolved":
      return { ...message, status: "Success", title: "Review thread resolved" };
    case "unresolved":
      return { ...message, status: "Info", title: "Review thread unresolved" };
    default:
      return undefined;
  }
}
