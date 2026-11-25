import type {
  APIApplicationCommandAutocompleteInteraction,
  APIApplicationCommandInteractionDataSubcommandOption,
  APIApplicationCommandOptionChoice,
  APIBaseInteraction,
  APIButtonComponentWithCustomId,
  APIChatInputApplicationCommandInteraction,
  APIContextMenuInteraction,
  APIInteractionResponseChannelMessageWithSource,
  APIInteractionResponseDeferredChannelMessageWithSource,
  APIInteractionResponseDeferredMessageUpdate,
  APIInteractionResponseUpdateMessage,
  APIMessageComponentButtonInteraction,
  APIMessageSelectMenuInteractionData,
  APIModalInteractionResponse,
  APIModalInteractionResponseCallbackData,
  APIModalSubmission,
  APISelectMenuComponent,
  ComponentType,
  InteractionType,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  RESTPostAPIContextMenuApplicationCommandsJSONBody,
} from "discord-api-types/v10";

import type { MaybePromise } from "../util/types.ts";

type DiscordCommandResponse =
  | APIInteractionResponseChannelMessageWithSource
  | APIInteractionResponseDeferredChannelMessageWithSource
  | APIModalInteractionResponse;

type DiscordComponentResponse =
  | APIInteractionResponseDeferredMessageUpdate
  | APIInteractionResponseUpdateMessage
  | APIModalInteractionResponse;

type DiscordModalSubmitResponse =
  | APIInteractionResponseChannelMessageWithSource
  | APIInteractionResponseDeferredChannelMessageWithSource;

/**
 * Mirrors how discord-api-types builds `APIMessageComponentSelectMenuInteraction`, but with `data` narrowed to a single
 * component's interaction data.
 */
type DiscordMessageComponentInteraction<Data> = APIBaseInteraction<InteractionType.MessageComponent, Data> &
  Required<
    Pick<
      APIBaseInteraction<InteractionType.MessageComponent, Data>,
      "app_permissions" | "channel_id" | "channel" | "data" | "message"
    >
  >;

// Commands

export type DiscordChatCommandRunner<Env = unknown> = (
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
) => MaybePromise<DiscordCommandResponse>;

export type DiscordSubcommandHandler<Env = unknown> = (
  subcommandOption: APIApplicationCommandInteractionDataSubcommandOption<InteractionType.ApplicationCommand>,
  env: Env,
  interactionToken: string,
) => MaybePromise<DiscordCommandResponse>;

export type DiscordAutocompleteHandler<Env = unknown> = (
  interaction: APIApplicationCommandAutocompleteInteraction,
  env: Env,
) => APIApplicationCommandOptionChoice[] | Promise<APIApplicationCommandOptionChoice[]>;

export type DiscordContextCommandHandler<Env = unknown> = (
  interaction: APIContextMenuInteraction,
  env: Env,
) => MaybePromise<DiscordCommandResponse>;

/**
 * Where a command is registered: `global` for every server the app is in and its DMs, or `guild` for only the servers
 * the discord worker's `command_guilds` table maps it to. A guild command names no guild itself.
 */
export type DiscordCommandScope = "global" | "guild";

export interface DiscordChatCommand<Env = unknown> {
  type: "chat";
  scope: DiscordCommandScope;
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  handleAutocomplete: DiscordAutocompleteHandler<Env>;
  handleCommand: DiscordChatCommandRunner<Env>;
  isEphemeral: boolean;
  isLongRunning: boolean;
}

export interface DiscordContextCommand<Env = unknown> {
  type: "context";
  scope: DiscordCommandScope;
  data: RESTPostAPIContextMenuApplicationCommandsJSONBody;
  handleCommand: DiscordContextCommandHandler<Env>;
  isEphemeral: boolean;
  isLongRunning: boolean;
  handleAutocomplete?: never;
}

export type DiscordCommand<Env = unknown> = DiscordChatCommand<Env> | DiscordContextCommand<Env>;

// Modals

export type DiscordModalSubmitHandler<Env = unknown> = (
  submission: APIModalSubmission,
  env: Env,
) => MaybePromise<DiscordModalSubmitResponse>;

export interface DiscordModal<Env = unknown> {
  data: APIModalInteractionResponseCallbackData;
  handleSubmit: DiscordModalSubmitHandler<Env>;
}

// Message Components

export type DiscordButtonHandler<Env = unknown> = (
  interaction: APIMessageComponentButtonInteraction,
  env: Env,
) => MaybePromise<DiscordComponentResponse>;

export interface DiscordButton<Env = unknown> {
  data: APIButtonComponentWithCustomId;
  handlePress: DiscordButtonHandler<Env>;
}

/** The `ComponentType`s of the five select menus (string, user, role, mentionable, channel). */
export type DiscordSelectMenuType = APISelectMenuComponent["type"];

export type DiscordSelectMenuDisplayHandler<T extends DiscordSelectMenuType, Env = unknown> = (
  env: Env,
) => MaybePromise<Extract<APISelectMenuComponent, { type: T }>>;

export type DiscordSelectMenuInteraction<T extends DiscordSelectMenuType> = DiscordMessageComponentInteraction<
  Extract<APIMessageSelectMenuInteractionData, { component_type: T }>
>;

export type DiscordSelectMenuInteractionHandler<T extends DiscordSelectMenuType, Env = unknown> = (
  interaction: DiscordSelectMenuInteraction<T>,
  env: Env,
) => MaybePromise<DiscordComponentResponse>;

export interface DiscordSelectMenu<T extends DiscordSelectMenuType, Env = unknown> {
  data: Extract<APISelectMenuComponent, { type: T }>;
  handleSelect: DiscordSelectMenuInteractionHandler<T, Env>;
}

export type DiscordStringSelectMenu<Env = unknown> = DiscordSelectMenu<ComponentType.StringSelect, Env>;
export type DiscordUserSelectMenu<Env = unknown> = DiscordSelectMenu<ComponentType.UserSelect, Env>;
export type DiscordRoleSelectMenu<Env = unknown> = DiscordSelectMenu<ComponentType.RoleSelect, Env>;
export type DiscordMentionableSelectMenu<Env = unknown> = DiscordSelectMenu<ComponentType.MentionableSelect, Env>;
export type DiscordChannelSelectMenu<Env = unknown> = DiscordSelectMenu<ComponentType.ChannelSelect, Env>;
