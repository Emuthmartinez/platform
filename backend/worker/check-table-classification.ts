/**
 * U7 / KTD10: every Drizzle table has exactly one reviewed classification.
 * No DATABASE_URL. Safe for CI on every PR.
 */
import {
  classificationProblems,
  drizzleTableNames,
  loadClassification,
} from "../src/lib/table-classification.js";

function main(): void {
  const file = loadClassification();
  const names = drizzleTableNames();
  const problems = classificationProblems(file, names);
  if (problems.length) {
    console.error("[table-classification] FAIL");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `[table-classification] OK: ${names.length} Drizzle tables match the reviewed artifact (${file.ktd}).`,
  );
}

main();
