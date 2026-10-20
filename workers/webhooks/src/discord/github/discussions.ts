import type { GithubWebhookPayload } from "../../types/github.ts";
import { escapeMarkdown } from "../markdown.ts";
import { type GithubMessage, userLink } from "../message.ts";
import { EXCERPT_LENGTH, formatBody, humanize, issueLink } from "./util.ts";

export function discussionMessage(payload: GithubWebhookPayload<"discussion">): GithubMessage | undefined {
  const { discussion, repository, sender } = payload;
  const message = {
    subject: issueLink(discussion),
    sender,
    details: [escapeMarkdown(discussion.category.name)],
    repository,
    link: { label: "View discussion", url: discussion.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "created":
      return { ...message, status: "Info", title: "Discussion created", body: [formatBody(discussion.body)] };
    case "closed": {
      const reason = discussion.state_reason;
      if (reason === "resolved") {
        return { ...message, status: "Success", title: "Discussion closed as resolved" };
      }
      return {
        ...message,
        status: "Draft",
        title:
          typeof reason === "string" && reason !== "reopened"
            ? `Discussion closed as ${humanize(reason)}`
            : "Discussion closed",
      };
    }
    case "reopened":
      return { ...message, status: "Info", title: "Discussion reopened" };
    case "locked":
      return { ...message, status: "Draft", title: "Discussion locked" };
    case "unlocked":
      return { ...message, status: "Info", title: "Discussion unlocked" };
    case "answered": {
      const { answer } = payload;
      return {
        ...message,
        status: "Success",
        title: "Discussion answered",
        body: [
          answer.user === null ? undefined : `**Answer from ${userLink(answer.user)}**`,
          formatBody(answer.body, EXCERPT_LENGTH),
        ],
        link: { label: "View answer", url: answer.html_url },
      };
    }
    case "unanswered":
      return { ...message, status: "Draft", title: "Discussion unanswered" };
    case "deleted":
      return { ...message, status: "Failure", title: "Discussion deleted", link: undefined };
    default:
      return undefined;
  }
}

export function discussionCommentMessage(
  payload: GithubWebhookPayload<"discussion_comment">,
): GithubMessage | undefined {
  const { comment, discussion, repository, sender } = payload;
  switch (payload.action) {
    case "created":
      return {
        status: "Info",
        title: comment.parent_id === null ? "New discussion comment" : "New discussion reply",
        subject: `On ${issueLink(discussion)}`,
        sender,
        body: [formatBody(comment.body)],
        repository,
        link: { label: "View comment", url: comment.html_url },
      };
    case "deleted":
      return {
        status: "Failure",
        title: "Discussion comment deleted",
        subject: `On ${issueLink(discussion)}`,
        sender,
        body: [formatBody(comment.body, EXCERPT_LENGTH)],
        repository,
        link: { label: "View discussion", url: discussion.html_url },
      };
    default:
      return undefined;
  }
}
