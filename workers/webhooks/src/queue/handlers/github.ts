// oxlint-disable unicorn/no-useless-switch-case
import type { MappedQueueMessageBatchHandler } from "@bachman-dev/workers-shared/cloudflare";
import {
  type APIMessageTopLevelComponent,
  ComponentType,
  splitComponentsToMessages,
} from "@bachman-dev/workers-shared/discord";
import { log } from "@bachman-dev/workers-shared/util";

import type { Env, QueueBodyMap } from "../../types/cloudflare.ts";
import { type GithubWebhookEvent, GithubWebhookEventName } from "../../types/github.ts";

const handleGithubWebhooks: MappedQueueMessageBatchHandler<"github-webhook-queue", QueueBodyMap, Env> = async (
  messages,
  env,
  _executionContext,
) => {
  const components: APIMessageTopLevelComponent[] = [];
  const promises = await Promise.allSettled(
    messages.map(async (message) => {
      const { deliveryId } = message.body;
      const deliveryObject = await env.GITHUB_BUCKET.get(`${deliveryId}.json`);
      if (deliveryObject === null) {
        throw new TypeError(`Delivery payload not found for ID ${deliveryId}`);
      }
      const webhook = await deliveryObject.json<GithubWebhookEvent>();
      switch (webhook.event) {
        case GithubWebhookEventName.CheckRun:
        case GithubWebhookEventName.CommitComment:
        case GithubWebhookEventName.Discussion:
        case GithubWebhookEventName.DiscussionComment:
        case GithubWebhookEventName.Fork:
        case GithubWebhookEventName.IssueComment:
        case GithubWebhookEventName.Issues:
        case GithubWebhookEventName.Member:
        case GithubWebhookEventName.Ping:
          components.push({
            type: ComponentType.Container,
            accent_color: 0x90ee90,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: `# Ping`,
              },
              {
                type: ComponentType.TextDisplay,
                content: `A ping event from ${webhook.payload.sender?.name ?? "someone"} arrived at the webhook and was sent to Discord.`,
              },
            ],
          });
          break;
        case GithubWebhookEventName.PullRequest:
        case GithubWebhookEventName.PullRequestReview:
        case GithubWebhookEventName.PullRequestReviewComment:
        case GithubWebhookEventName.PullRequestReviewThread:
        case GithubWebhookEventName.Push:
        case GithubWebhookEventName.Release:
        case GithubWebhookEventName.Repository:
        case GithubWebhookEventName.RepositoryAdvisory:
        case GithubWebhookEventName.RepositoryImport:
        case GithubWebhookEventName.RepositoryVulnerabilityAlert:
        case GithubWebhookEventName.SecretScanningAlert:
        case GithubWebhookEventName.SecretScanningAlertLocation:
        case GithubWebhookEventName.SecretScanningScan:
        case GithubWebhookEventName.SubIssues:
        case GithubWebhookEventName.Watch:
        default:
          await env.DEAD_LETTER_QUEUE.send(message);
      }
      message.ack();
    }),
  );

  for (const [index, promise] of promises.entries()) {
    if (promise.status === "rejected") {
      log("error", `Error on GitHub Queue Message ${index + 1} -- ${promise.reason}`);
    }
  }

  const results = splitComponentsToMessages("webhook", components);
  if (results.messages.length > 0) {
    await env.DISCORD_QUEUE.sendBatch(
      results.messages.map((body) => {
        return {
          body: {
            format: "webhook",
            webhookId: "",
            body,
          },
        };
      }),
    );
  }
};

export default handleGithubWebhooks;
