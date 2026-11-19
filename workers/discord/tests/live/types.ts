/** The bot, channel and ref for a live run against Discord. */
export interface LiveDiscord {
  applicationId: string;
  channelId: string;
  botToken: string;
  ref: string;
}
