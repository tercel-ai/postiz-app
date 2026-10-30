/** Compatibility entry point. Recovery now calls the service directly, without HTTP or tokens. */
import { runCli } from './recover-legacy-calendar';
if (require.main === module) void runCli();
