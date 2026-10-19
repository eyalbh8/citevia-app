import type { SqlDatabase } from '../packages/storage/src/sql.js';

/** Never relabel the former development fixtures as real observations. */
export async function assertRealLocalData(db: SqlDatabase): Promise<void> {
  const { rows } = await db.query<{ found: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM citevia_runs WHERE data->>'trigger'='demo')
      OR EXISTS (SELECT 1 FROM citevia_projects WHERE id='northstar-demo' OR data#>>'{brandbook,model}'='demo-fixture')
      OR EXISTS (SELECT 1 FROM citevia_prompt_results WHERE data->>'model'='demo-fixture') AS found
  `);
  if (rows[0]?.found)
    throw new Error(
      'This local store contains legacy sample data. It has been preserved. Use a fresh LOCAL_DATA_DIR such as .local-data/real; sample stores cannot be opened by the application.',
    );
}
