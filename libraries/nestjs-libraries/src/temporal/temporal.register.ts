import {
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
import { Connection } from '@temporalio/client';

@Injectable()
export class TemporalRegister implements OnModuleInit {
  private readonly logger = new Logger(TemporalRegister.name);

  constructor(private _client: TemporalService) {}

  // Registers the custom search attributes PostsService queries on
  // (`workflow.list({ query: 'postId="..." AND ExecutionStatus="Running"' })`,
  // used to terminate superseded post workflows). Deliberately NOT wrapped in a
  // try/catch: an unreachable Temporal must fail boot loudly rather than leave
  // the app running with workflow queries that silently match nothing.
  async onModuleInit(): Promise<void> {
    const namespace = process.env.TEMPORAL_NAMESPACE || 'default';
    const connection = this._client?.client?.getRawClient()?.connection as
      | Connection
      | undefined;

    // The optional chaining above yields undefined when the Temporal client
    // isn't wired up; say which piece is missing instead of throwing a bare
    // "Cannot read properties of undefined (reading 'operatorService')".
    if (!connection?.operatorService) {
      throw new Error(
        'TemporalRegister: no Temporal connection available — cannot register ' +
          'custom search attributes (organizationId, postId).'
      );
    }

    const { customAttributes } = await connection.operatorService.listSearchAttributes({
      namespace,
    });

    const neededAttribute = ['organizationId', 'postId'];
    const missingAttributes = neededAttribute.filter(
      (attr) => !customAttributes[attr],
    );

    // Always log the namespace: these attributes are per-namespace, so a
    // mismatch between TEMPORAL_NAMESPACE and the namespace you inspect (e.g.
    // `temporal operator search-attribute list --namespace default`) makes them
    // look unregistered when they are simply registered somewhere else.
    if (missingAttributes.length === 0) {
      this.logger.log(
        `Temporal search attributes already registered on namespace "${namespace}": ${neededAttribute.join(', ')}`,
      );
      return;
    }

    await connection.operatorService.addSearchAttributes({
      namespace,
      searchAttributes: missingAttributes.reduce((all, current) => {
        // @ts-ignore
        all[current] = 1;
        return all;
      }, {}),
    });
    this.logger.log(
      `Registered Temporal search attributes on namespace "${namespace}": ${missingAttributes.join(', ')}`,
    );
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [TemporalRegister],
  get exports() {
    return this.providers;
  },
})
export class TemporalRegisterMissingSearchAttributesModule {}
