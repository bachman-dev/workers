// oxlint-disable unicorn/no-useless-switch-case
import type { APIMessageTopLevelComponent } from "@bachman-dev/workers-shared/discord";

import * as messages from "./github/index.ts";
import { type GithubWebhookEvent, GithubWebhookEventName } from "../types/github.ts";
import { type GithubMessage, type MessageContext, buildGithubMessage } from "./message.ts";

/** Marks an event that has no Discord message yet, as opposed to an action that is deliberately not posted. */
const NOT_IMPLEMENTED = Symbol("not implemented");

function githubEventMessage(webhook: GithubWebhookEvent): GithubMessage | undefined | typeof NOT_IMPLEMENTED {
  switch (webhook.event) {
    case GithubWebhookEventName.Ping:
      return messages.pingMessage(webhook.payload);
    case GithubWebhookEventName.CheckRun:
      return messages.checkRunMessage(webhook.payload);
    case GithubWebhookEventName.CommitComment:
      return messages.commitCommentMessage(webhook.payload);
    case GithubWebhookEventName.Discussion:
      return messages.discussionMessage(webhook.payload);
    case GithubWebhookEventName.DiscussionComment:
      return messages.discussionCommentMessage(webhook.payload);
    case GithubWebhookEventName.Fork:
      return messages.forkMessage(webhook.payload);
    case GithubWebhookEventName.IssueComment:
      return messages.issueCommentMessage(webhook.payload);
    case GithubWebhookEventName.Issues:
      return messages.issuesMessage(webhook.payload);
    case GithubWebhookEventName.Member:
      return messages.memberMessage(webhook.payload);
    case GithubWebhookEventName.PullRequest:
      return messages.pullRequestMessage(webhook.payload);
    case GithubWebhookEventName.PullRequestReview:
      return messages.pullRequestReviewMessage(webhook.payload);
    case GithubWebhookEventName.PullRequestReviewComment:
      return messages.pullRequestReviewCommentMessage(webhook.payload);
    case GithubWebhookEventName.PullRequestReviewThread:
      return messages.pullRequestReviewThreadMessage(webhook.payload);
    case GithubWebhookEventName.Push:
      return messages.pushMessage(webhook.payload);
    case GithubWebhookEventName.Release:
      return messages.releaseMessage(webhook.payload);
    case GithubWebhookEventName.Repository:
      return messages.repositoryMessage(webhook.payload);
    case GithubWebhookEventName.RepositoryAdvisory:
      return messages.repositoryAdvisoryMessage(webhook.payload);
    case GithubWebhookEventName.RepositoryImport:
      return messages.repositoryImportMessage(webhook.payload);
    case GithubWebhookEventName.RepositoryVulnerabilityAlert:
      return messages.repositoryVulnerabilityAlertMessage(webhook.payload);
    case GithubWebhookEventName.SecretScanningAlert:
      return messages.secretScanningAlertMessage(webhook.payload);
    case GithubWebhookEventName.SecretScanningAlertLocation:
      return messages.secretScanningAlertLocationMessage(webhook.payload);
    case GithubWebhookEventName.SubIssues:
      return messages.subIssuesMessage(webhook.payload);
    case GithubWebhookEventName.Watch:
      return messages.watchMessage(webhook.payload);
    case GithubWebhookEventName.SecretScanningScan:
    default:
      return NOT_IMPLEMENTED;
  }
}

/**
 * Builds the Discord component for a GitHub webhook event.
 *
 * @param {GithubWebhookEvent} webhook - The event and its payload.
 * @param {MessageContext} context - Settings shared by every message.
 * @returns {APIMessageTopLevelComponent | undefined | typeof NOT_IMPLEMENTED} The component to post, `undefined` for an
 *   action that is deliberately not posted, or {@link NOT_IMPLEMENTED} for an event with no message yet.
 */
export function githubEventComponent(
  webhook: GithubWebhookEvent,
  context: MessageContext,
): APIMessageTopLevelComponent | undefined | typeof NOT_IMPLEMENTED {
  const githubMessage = githubEventMessage(webhook);
  if (githubMessage === NOT_IMPLEMENTED || githubMessage === undefined) {
    return githubMessage;
  }
  return buildGithubMessage(githubMessage, context);
}

export { NOT_IMPLEMENTED };
