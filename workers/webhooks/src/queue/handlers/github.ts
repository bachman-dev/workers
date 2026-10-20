// oxlint-disable unicorn/no-useless-switch-case
import type { MappedQueueMessageBatchHandler } from "@bachman-dev/workers-shared/cloudflare";
import { type APIMessageTopLevelComponent, splitComponentsToMessages } from "@bachman-dev/workers-shared/discord";

import * as messages from "../../discord/github/index.ts";
import { type GithubMessage, type MessageContext, buildGithubMessage } from "../../discord/message.ts";
import type { Env, QueueBodyMap } from "../../types/cloudflare.ts";
import { type GithubWebhookEvent, GithubWebhookEventName } from "../../types/github.ts";

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

const handleGithubWebhooks: MappedQueueMessageBatchHandler<"github-webhook-queue", QueueBodyMap, Env> = async (
  queueMessages,
  env,
) => {
  const context: MessageContext = { mentionId: env.DISCORD_MENTION_ID };
  const rejectedMessages: unknown[] = [];
  const promises = await Promise.allSettled(
    queueMessages.map(async (message): Promise<APIMessageTopLevelComponent | undefined> => {
      const { deliveryId } = message.body;
      const deliveryObject = await env.GITHUB_BUCKET.get(`${deliveryId}.json`);
      if (deliveryObject === null) {
        rejectedMessages.push({ error: "GH_WEBHOOK_NO_PAYLOAD_FOUND", message });
        throw new TypeError(`Delivery payload not found for ID ${deliveryId}`);
      }
      const webhook = await deliveryObject.json<GithubWebhookEvent>();
      const githubMessage = githubEventMessage(webhook);
      message.ack();
      if (githubMessage === NOT_IMPLEMENTED) {
        rejectedMessages.push({ error: "GH_WEBHOOK_EVENT_NOT_IMPLEMENTED", message });
        return undefined;
      }
      // Actions we don't post, e.g. an issue being labeled, are acknowledged without a message
      return githubMessage === undefined ? undefined : buildGithubMessage(githubMessage, context);
    }),
  );

  // Keep the components in delivery order rather than the order their payloads finished loading
  const components: APIMessageTopLevelComponent[] = [];
  for (const [index, promise] of promises.entries()) {
    if (promise.status === "rejected") {
      rejectedMessages.push({ error: "GH_REJECTED_MESSAGE_PROMISE", index, message: queueMessages[index] });
    } else if (promise.value !== undefined) {
      components.push(promise.value);
    }
  }

  const results = splitComponentsToMessages("webhook", components);
  if (results.errors.length > 0) {
    rejectedMessages.push({ error: "GH_DISCORD_MESSAGE_TOO_BIG", errors: results.errors });
  }
  if (rejectedMessages.length > 0) {
    await env.DEAD_LETTER_QUEUE.sendBatch(
      rejectedMessages.map((message) => {
        return {
          body: message,
          contentType: "json",
        };
      }),
    );
  }
  if (results.messages.length > 0) {
    await env.DISCORD_QUEUE.sendBatch(
      results.messages.map((body) => {
        return {
          body: {
            format: "webhook",
            webhookId: env.GITHUB_WEBHOOK_ID,
            // GitHub text can contain @everyone or Discord mention syntax, so only ever ping the configured user
            body: { ...body, allowed_mentions: { parse: [], users: [env.DISCORD_MENTION_ID] } },
          },
        };
      }),
    );
  }
};

export default handleGithubWebhooks;
