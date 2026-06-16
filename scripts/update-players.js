const fs = require("fs");

const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

if (!csvUrl) {
  throw new Error("Missing GOOGLE_SHEET_CSV_URL");
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function cleanNickname(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
}

async function main() {
  const response = await fetch(csvUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch sheet: ${response.status}`);
  }

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);

  const rows = lines.slice(1).map(parseCsvLine);

  const seen = new Set();
  const players = [];

  for (const row of rows) {
    // Google Forms usually gives:
    // row[0] = Timestamp
    // row[1] = PSN nickname
    const nickname = cleanNickname(row[1]);

    if (!nickname) continue;

    const key = nickname.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);

    players.push({
      name: nickname
    });
  }

  players.sort((a, b) => a.name.localeCompare(b.name));

  fs.writeFileSync("players.json", JSON.stringify(players, null, 2));

  console.log(`Updated players.json with ${players.length} players.`);
}

main();
