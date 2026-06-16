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
    const nextChar = line[i + 1];

    if (char === '"' && nextChar === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
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

function getProfileUrl(nickname) {
  return "https://www.exophase.com/psn/user/" + encodeURIComponent(nickname) + "/";
}

function getOldStyleCardUrl(nickname) {
  return "https://card.exophase.com/psn/" + encodeURIComponent(nickname) + ".png";
}

function findCardUrlFromHtml(html) {
  const matches = [
    /https:\/\/card\.exophase\.com\/[^"' <>\]]+\.png/gi,
    /https:\\\/\\\/card\.exophase\.com\\\/[^"' <>\]]+\.png/gi
  ];

  for (const regex of matches) {
    const found = html.match(regex);

    if (found && found.length) {
      return found[0]
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&");
    }
  }

  return "";
}

async function fetchCardUrl(nickname) {
  const profileUrl = getProfileUrl(nickname);

  try {
    const response = await fetch(profileUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 GitHubAction PSN Player Cards"
      }
    });

    if (!response.ok) {
      console.log(`Profile fetch failed for ${nickname}: ${response.status}`);
      return "";
    }

    const html = await response.text();
    const cardUrl = findCardUrlFromHtml(html);

    if (cardUrl) {
      console.log(`Found card for ${nickname}: ${cardUrl}`);
      return cardUrl;
    }

    console.log(`No direct card found for ${nickname}`);
    return "";

  } catch (error) {
    console.log(`Error fetching card for ${nickname}: ${error.message}`);
    return "";
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const names = [];

  for (const row of rows) {
    const nickname = cleanNickname(row[1]);

    if (!nickname) continue;

    const key = nickname.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    names.push(nickname);
  }

  names.sort((a, b) => a.localeCompare(b));

  const players = [];

  for (const nickname of names) {
    const directCardUrl = await fetchCardUrl(nickname);

    players.push({
      name: nickname,
      profileUrl: getProfileUrl(nickname),
      cardUrl: directCardUrl || getOldStyleCardUrl(nickname)
    });

    await sleep(500);
  }

  fs.writeFileSync("players.json", JSON.stringify(players, null, 2));

  console.log(`Updated players.json with ${players.length} players.`);
}

main();
