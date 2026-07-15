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
  return (
    "https://www.exophase.com/psn/user/" +
    encodeURIComponent(nickname) +
    "/"
  );
}

function getFallbackCardUrl(nickname) {
  return (
    "https://card.exophase.com/psn/" +
    encodeURIComponent(nickname) +
    ".png"
  );
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

function extractPsnLevel(text) {
  if (!text) {
    return 0;
  }

  /*
    Exophase may place the trophy level in HTML, JSON, alt text,
    title text or JavaScript data. These patterns cover several
    likely formats.
  */
  const patterns = [
    /"trophyLevel"\s*:\s*"?([0-9]{1,3})"?/i,
    /"trophy_level"\s*:\s*"?([0-9]{1,3})"?/i,
    /"psnLevel"\s*:\s*"?([0-9]{1,3})"?/i,
    /"psn_level"\s*:\s*"?([0-9]{1,3})"?/i,
    /data-trophy-level=["']([0-9]{1,3})["']/i,
    /data-psn-level=["']([0-9]{1,3})["']/i,
    /trophy[-_\s]*level[^0-9]{0,100}([0-9]{1,3})/i,
    /psn[-_\s]*level[^0-9]{0,100}([0-9]{1,3})/i,
    /(?:trophy level|psn level)[^0-9]{0,100}([0-9]{1,3})/i,
    /([0-9]{1,3})[^a-z0-9]{0,20}(?:trophy level|psn level)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match || !match[1]) {
      continue;
    }

    const level = Number.parseInt(match[1], 10);

    if (Number.isInteger(level) && level >= 1 && level <= 999) {
      return level;
    }
  }

  return 0;
}

async function fetchProfileData(nickname) {
  const profileUrl = getProfileUrl(nickname);

  try {
    const response = await fetch(profileUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/126.0 Safari/537.36"
      }
    });

    if (!response.ok) {
      throw new Error(`Profile returned HTTP ${response.status}`);
    }

    const text = await response.text();

    return {
      cardUrl: extractCardUrl(text),
      psnLevel: extractPsnLevel(text)
    };
  } catch (error) {
    console.log(
      `Profile scan failed for ${nickname}: ${error.message}`
    );

    return {
      cardUrl: "",
      psnLevel: 0
    };
  }
}

async function tryGetGeneratedCardUrl(nickname) {
  const formUrl = "https://gamercards.exophase.com/";
  const body = new URLSearchParams();

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
      "User-Agent":
        "Mozilla/5.0 GitHubAction PSN Player Cards"
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error(`Generator returned HTTP ${response.status}`);
  }

  const text = await response.text();

  return extractCardUrl(text);
}

async function getBestCardUrl(nickname, profileCardUrl) {
  if (profileCardUrl) {
    console.log(
      `Profile card URL for ${nickname}: ${profileCardUrl}`
    );

    return profileCardUrl;
  }

  try {
    const generatedCardUrl =
      await tryGetGeneratedCardUrl(nickname);

    if (generatedCardUrl) {
      console.log(
        `Generated card URL for ${nickname}: ${generatedCardUrl}`
      );

      return generatedCardUrl;
    }
  } catch (error) {
    console.log(
      `Generator failed for ${nickname}: ${error.message}`
    );
  }

  const fallback = getFallbackCardUrl(nickname);

  console.log(
    `Using fallback card URL for ${nickname}: ${fallback}`
  );

  return fallback;
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const response = await fetch(csvUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Google Sheet: ${response.status}`
    );
  }

  const csv = await response.text();

  const lines = csv
    .split(/\r?\n/)
    .filter(function(line) {
      return line.trim() !== "";
    });

  const rows = lines
    .slice(1)
    .map(parseCsvLine);

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

  const players = [];

  for (const nickname of names) {
    console.log(`Processing ${nickname}...`);

    const profileData = await fetchProfileData(nickname);

    const cardUrl = await getBestCardUrl(
      nickname,
      profileData.cardUrl
    );

    players.push({
      name: nickname,
      profileUrl: getProfileUrl(nickname),
      cardUrl: cardUrl,
      psnLevel: profileData.psnLevel
    });

    if (profileData.psnLevel > 0) {
      console.log(
        `PSN trophy level for ${nickname}: ` +
        profileData.psnLevel
      );
    } else {
      console.log(
        `Could not detect PSN trophy level for ${nickname}`
      );
    }

    await sleep(800);
  }

  /*
    Highest PSN trophy level first.

    Players whose level could not be detected receive level 0
    and appear at the bottom. Equal levels are sorted by name.
  */
  players.sort(function(a, b) {
    const levelDifference =
      Number(b.psnLevel || 0) -
      Number(a.psnLevel || 0);

    if (levelDifference !== 0) {
      return levelDifference;
    }

    return a.name.localeCompare(b.name);
  });

  fs.writeFileSync(
    "players.json",
    JSON.stringify(players, null, 2),
    "utf8"
  );

  console.log(
    `Updated players.json with ${players.length} players.`
  );
}

main().catch(function(error) {
  console.error(error);
  process.exit(1);
});
