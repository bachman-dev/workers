/** What a fake message was told to do. */
interface Forwarded {
  rcptTo: string;
  headers: Headers;
}

/** Options for a fake message. */
interface FakeMessageOptions {
  /** The message's headers, e.g. From and Authentication-Results. */
  headers: Record<string, string | string[]>;
  /** Whether Email Routing can forward it; defaults to true. */
  canBeForwarded?: boolean;
  /** Makes `forward()` reject with this error. */
  forwardError?: Error;
}

/** A stand-in for the message Email Routing hands the worker, recording what the worker does with it. */
export default class FakeEmailMessage implements ForwardableEmailMessage {
  public readonly from = "bounces@example.org";
  // oxlint-disable-next-line id-length -- EmailMessage names it
  public readonly to = "someone@bachman.dev";
  public readonly headers: Headers;
  public readonly raw = new ReadableStream<Uint8Array>();
  public readonly rawSize = 0;
  public readonly canBeForwarded: boolean;
  public readonly forwarded: Forwarded[] = [];
  public readonly rejections: string[] = [];
  /** How many times the worker tried to reply. */
  public replies = 0;
  readonly #forwardError: Error | undefined;

  public constructor(options: FakeMessageOptions) {
    this.headers = new Headers();
    for (const [name, value] of Object.entries(options.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        this.headers.append(name, item);
      }
    }
    this.canBeForwarded = options.canBeForwarded ?? true;
    this.#forwardError = options.forwardError;
  }

  /**
   * Records a forward, or fails it if the message was built to.
   *
   * @param {string} rcptTo - Where the worker forwarded the message.
   * @param {Headers | undefined} headers - The headers it added.
   * @returns {Promise<EmailSendResult>} A fake result.
   */
  public async forward(rcptTo: string, headers?: Headers): Promise<EmailSendResult> {
    if (this.#forwardError !== undefined) {
      throw this.#forwardError;
    }
    this.forwarded.push({ rcptTo, headers: headers ?? new Headers() });
    return await Promise.resolve({ messageId: "fake-message-id" });
  }

  /**
   * Counts a reply attempt and fails it; the worker must never auto-reply.
   *
   * @param {EmailMessage | EmailReplyMessageBuilder} _message - The reply.
   * @returns {Promise<EmailSendResult>} Never resolves.
   */
  public async reply(_message: EmailMessage | EmailReplyMessageBuilder): Promise<EmailSendResult> {
    this.replies += 1;
    return await Promise.reject(new Error("The worker must not reply"));
  }

  /**
   * Records a rejection.
   *
   * @param {string} reason - The reason given.
   */
  public setReject(reason: string): void {
    this.rejections.push(reason);
  }
}
