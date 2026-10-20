import type { GithubWebhookPayload } from "../../types/github.ts";
import type { GithubMessage, MessageLink } from "../message.ts";
import { EXCERPT_LENGTH, type GithubIssueLike, assigneeLine, formatBody, humanize, issueLink } from "./util.ts";

export function issuesMessage(payload: GithubWebhookPayload<"issues">): GithubMessage | undefined {
  const { issue, repository, sender } = payload;
  const message = {
    subject: issueLink(issue),
    sender,
    repository,
    link: { label: "View issue", url: issue.html_url },
  } satisfies Partial<GithubMessage>;

  switch (payload.action) {
    case "opened":
      return { ...message, status: "Info", title: "Issue opened", body: [formatBody(issue.body)] };
    case "closed": {
      const reason = issue.state_reason;
      if (typeof reason !== "string" || reason === "completed") {
        return {
          ...message,
          status: "Success",
          title: reason === "completed" ? "Issue closed as completed" : "Issue closed",
        };
      }
      return { ...message, status: "Draft", title: `Issue closed as ${humanize(reason)}` };
    }
    case "reopened":
      return { ...message, status: "Info", title: "Issue reopened" };
    case "deleted":
      return { ...message, status: "Failure", title: "Issue deleted", link: undefined };
    case "assigned":
      return {
        ...message,
        status: "Attention",
        title: "Issue assigned",
        body: [assigneeLine("Assigned to", payload.assignee)],
      };
    case "unassigned":
      return {
        ...message,
        status: "Info",
        title: "Issue unassigned",
        body: [assigneeLine("Unassigned", payload.assignee)],
      };
    case "locked": {
      const reason = issue.active_lock_reason;
      return {
        ...message,
        status: "Draft",
        title: typeof reason === "string" ? `Issue locked as ${humanize(reason)}` : "Issue locked",
      };
    }
    case "unlocked":
      return { ...message, status: "Info", title: "Issue unlocked" };
    default:
      return undefined;
  }
}

export function issueCommentMessage(payload: GithubWebhookPayload<"issue_comment">): GithubMessage | undefined {
  const { comment, issue, repository, sender } = payload;
  const kind = issue.pull_request === undefined ? "issue" : "pull request";
  switch (payload.action) {
    case "created":
      return {
        status: "Info",
        title: `New ${kind} comment`,
        subject: `On ${issueLink(issue)}`,
        sender,
        body: [formatBody(comment.body)],
        repository,
        link: { label: "View comment", url: comment.html_url },
      };
    case "deleted":
      return {
        status: "Failure",
        title: `${kind === "issue" ? "Issue" : "Pull request"} comment deleted`,
        subject: `On ${issueLink(issue)}`,
        sender,
        body: [formatBody(comment.body, EXCERPT_LENGTH)],
        repository,
        link: { label: `View ${kind}`, url: issue.html_url },
      };
    default:
      return undefined;
  }
}

export function subIssuesMessage(payload: GithubWebhookPayload<"sub_issues">): GithubMessage | undefined {
  const { repository, sender } = payload;
  // Issues in another repository are prefixed with its name
  const otherRepository = (name: string | undefined): string | undefined =>
    name === repository.full_name ? undefined : name;

  let added: boolean;
  let parentIssue: GithubIssueLike | undefined;
  let parentRepository: string | undefined;
  let subIssue: GithubIssueLike | undefined;
  let subIssueRepository: string | undefined;
  switch (payload.action) {
    case "sub_issue_added":
    case "sub_issue_removed":
      added = payload.action === "sub_issue_added";
      parentIssue = payload.parent_issue;
      subIssue = payload.sub_issue;
      subIssueRepository = otherRepository(payload.sub_issue_repo?.full_name);
      break;
    case "parent_issue_added":
    case "parent_issue_removed":
      // The parent's repository gets a `sub_issue_*` event for the same change, so only report it from here when the
      // parent is in another repository
      if (payload.parent_issue_repo === undefined || payload.parent_issue_repo.id === repository.id) {
        return undefined;
      }
      added = payload.action === "parent_issue_added";
      parentIssue = payload.parent_issue;
      parentRepository = otherRepository(payload.parent_issue_repo.full_name);
      subIssue = payload.sub_issue;
      break;
    default:
      return undefined;
  }

  const parentUrl = parentIssue?.html_url;
  const subIssueUrl = subIssue?.html_url;
  let link: MessageLink | undefined;
  if (typeof parentUrl === "string") {
    link = { label: "View parent issue", url: parentUrl };
  } else if (typeof subIssueUrl === "string") {
    link = { label: "View sub-issue", url: subIssueUrl };
  }
  return {
    status: added ? "Info" : "Draft",
    title: added ? "Sub-issue added" : "Sub-issue removed",
    subject:
      parentIssue === undefined ? undefined : `${added ? "To" : "From"} ${issueLink(parentIssue, parentRepository)}`,
    sender,
    body: [subIssue === undefined ? undefined : `**Sub-issue:** ${issueLink(subIssue, subIssueRepository)}`],
    repository,
    link,
  };
}
