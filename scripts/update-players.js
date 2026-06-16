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

function getFallbackCardUrl(nickname) {
  return "https://card.exophase.com/psn/" + encodeURIComponent(nickname) + ".png";
}

function extractCardUrl(text) {
  if (!text) {
    return "";
  }

  const patterns = [
    /https:\/\/card\.exophase\.com\/[0-9]+\/[0-9]+\.png/g,
    /https:\/\/card\.exophase\.com\/psn\/[^"' <>\]]+\.png/g,
    /https:\\\/\\\/card\.exophase\.com\\\/[0-9]+\\\/[0-9]+\.png/g,
    /https:\\\/\\\/card\.exophase\.com\\\/psn\\\/[^"' <>\]]+\.png/g
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match && match[0]) {
      return match[0]
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&");
    }
  }

  return "";
}

async function tryGetGeneratedCardUrl(nickname) {
  const formUrl = "https://gamercards.exophase.com/";

  const body = new URLSearchParams();

  /*
    These field names are based on the visible Exophase gamercard generator:
    top platform = PSN
    top gamertag = nickname
    show games = enabled
  */

  body.set("top_platform", "psn");
  body.set("top_gamertag", nickname);
  body.set("top_show", "games");
  body.set("bottom_platform", "");
  body.set("bottom_gamertag", "");
  body.set("bottom_show", "games");

  const response = await fetch(formUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 GitHubAction PSN Player Cards"
    },
    body: body.toString()
  });

  const text = await response.text();
  const cardUrl = extractCardUrl(text);

  return cardUrl;
}

async function tryGetCardFromProfilePage(nickname) {
  const response = await fetch(getProfileUrl(nickname), {
    headers: {
      "User-Agent": "Mozilla/5.0 GitHubAction PSN Player Cards"
    }
  });

  const text = await response.text();
  return extractCardUrl(text);
}

async function getBestCardUrl(nickname) {
  try {
    const generatedCardUrl = await tryGetGeneratedCardUrl(nickname);

    if (generatedCardUrl) {
      console.log(`Generated card URL for ${nickname}: ${generatedCardUrl}`);
      return generatedCardUrl;
    }
  } catch (error) {
    console.log(`Generator failed for ${nickname}: ${error.message}`);
  }

  try {
    const profileCardUrl = await tryGetCardFromProfilePage(nickname);

    if (profileCardUrl) {
      console.log(`Profile card URL for ${nickname}: ${profileCardUrl}`);
      return profileCardUrl;
    }
  } catch (error) {
    console.log(`Profile scan failed for ${nickname}: ${error.message}`);
  }

  const fallback = getFallbackCardUrl(nickname);
  console.log(`Using fallback card URL for ${nickname}: ${fallback}`);
  return fallback;
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

    if (!nickname) {
      continue;
    }

    const key = nickname.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    names.push(nickname);
  }

  names.sort((a, b) => a.localeCompare(b));

  const players = [];

  for (const nickname of names) {
    const cardUrl = await getBestCardUrl(nickname);

    players.push({
      name: nickname,
      profileUrl: getProfileUrl(nickname),
      cardUrl: cardUrl
    });

    await sleep(800);
  }

  fs.writeFileSync("players.json", JSON.stringify(players, null, 2));

  console.log(`Updated players.json with ${players.length} players.`);
}

main();
