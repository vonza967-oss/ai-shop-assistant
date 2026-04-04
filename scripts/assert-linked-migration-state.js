import { readFileSync } from "node:fs";

function readInput(filePath) {
  if (filePath) {
    return readFileSync(filePath, "utf8");
  }

  return readFileSync(0, "utf8");
}

function parseMigrationRows(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d{14})?\s*[|│]\s*(\d{14})?\s*[|│]/);

      if (!match) {
        return null;
      }

      return {
        local: match[1] || "",
        remote: match[2] || "",
      };
    })
    .filter(Boolean);
}

function main() {
  const text = readInput(process.argv[2]);
  const rows = parseMigrationRows(text);

  if (!rows.length) {
    throw new Error("Could not parse any supabase migration rows from the CLI output.");
  }

  const mismatches = rows.filter(({ local, remote }) => local !== remote);

  if (mismatches.length) {
    const formatted = mismatches
      .map(({ local, remote }) => `local=${local || "<missing>"} remote=${remote || "<missing>"}`)
      .join("\n");
    throw new Error(`Supabase migration history is out of sync after db push:\n${formatted}`);
  }

  console.log(`Supabase migration history is synchronized across ${rows.length} version(s).`);
}

main();
