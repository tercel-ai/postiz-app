/** Compatibility entry point for offline profile uniqueness SQL preparation. */
export { prepareSqlMigration as prepareProfileUniquenessMigration } from './prepare-sql-migration';
import { runPreparation } from './prepare-sql-migration';

if (require.main === module) runPreparation('profile-uniqueness');
