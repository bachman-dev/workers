export type MappedQueueMessageBatch<QueueNames extends string, QueueBodyMap extends Record<QueueNames, unknown>> = {
  [Queue in QueueNames]: {
    messages: readonly Message<QueueBodyMap[Queue]>[];
    queue: Queue;
  };
}[QueueNames] &
  Omit<MessageBatch, "messages">;

export type MappedQueueHandler<
  QueueNames extends string,
  QueueBodyMap extends Record<QueueNames, unknown>,
  Bindings = unknown,
> = (
  batch: MappedQueueMessageBatch<QueueNames, QueueBodyMap>,
  env: Bindings,
  ctx: ExecutionContext,
) => Promise<void> | void;

export type MappedQueueMessageBatchHandler<
  QueueNames extends string,
  QueueBodyMap extends Record<QueueNames, unknown>,
  Bindings = unknown,
> = (
  messages: readonly Message<QueueBodyMap[QueueNames]>[],
  env: Bindings,
  executionContext: ExecutionContext,
) => Promise<void> | void;

export type MappedExportedHandler<
  QueueNames extends string,
  QueueBodyMap extends Record<QueueNames, unknown>,
  Bindings = unknown,
> = Omit<ExportedHandler<Bindings>, "queue"> & {
  queue?: MappedQueueHandler<QueueNames, QueueBodyMap, Bindings>;
};
