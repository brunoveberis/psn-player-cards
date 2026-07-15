const fs = require("fs");

const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

if (!csvUrl) {
  throw new Error("Missing GOOGLE_SHEET_CSV_URL");
}

const OUTPUT_FILE = "players.json";

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/126.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

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

function getCardUrl(nickname) {
  return (
    "https://card.exophase.com/psn/" +
    encodeURIComponent(nickname) +
    ".png"
  );
}

function sleep(milliseconds) {
  return new Promise(function(resolve) {
    setTimeout(resolve, milliseconds);
  });
}

function decodeHtmlEntities(text) {
  const namedEntities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };

  return String(text || "")
    .replace(
      /&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
      function(match, entity) {
        const lowerEntity = entity.toLowerCase();

        if (namedEntities[lowerEntity] !== undefined) {
          return namedEntities[lowerEntity];
        }

        if (lowerEntity.startsWith("#x")) {
          const code = Number.parseInt(
            lowerEntity.slice(2),
            16
          );

          return Number.isFinite(code)
            ? String.fromCodePoint(code)
            : " ";
        }

        if (lowerEntity.startsWith("#")) {
          const code = Number.parseInt(
            lowerEntity.slice(1),
            10
          );

          return Number.isFinite(code)
            ? String.fromCodePoint(code)
            : " ";
        }

        return " ";
      }
    );
}

function htmlToVisibleText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function isValidPsnLevel(value) {
  return (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 999
  );
}

function extractPsnLevel(html, nickname) {
  const visibleText = htmlToVisibleText(html);
  const escapedNickname = escapeRegExp(nickname);

  /*
    Exophase profile header text appears in this order:

    nickname
    PSN trophy level
    progress percentage

    Example:
    PikxelisLV 316 20.38%
  */
  const nicknamePattern = new RegExp(
    "(?:^|\\s)" +
      escapedNickname +
      "\\s+(\\d{1,3})\\s+" +
      "\\d{1,3}(?:[.,]\\d+)?%",
    "i"
  );

  const nicknameMatch = visibleText.match(
    nicknamePattern
  );

  if (nicknameMatch && nicknameMatch[1]) {
    const level = Number.parseInt(
      nicknameMatch[1],
      10
    );

    if (isValidPsnLevel(level)) {
      return level;
    }
  }

  /*
    Fallback for minor Exophase layout changes.

    Locate the first percentage after the player's name,
    then inspect the short section immediately before it.
  */
  const lowerText = visibleText.toLowerCase();
  const lowerNickname = nickname.toLowerCase();

  const nicknameIndex =
    lowerText.indexOf(lowerNickname);

  if (nicknameIndex !== -1) {
    const textAfterNickname = visibleText.slice(
      nicknameIndex + nickname.length
    );

    const percentageMatch =
      textAfterNickname.match(
        /\d{1,3}(?:[.,]\d+)?%/
      );

    if (percentageMatch && percentageMatch.index !== undefined) {
      const beforePercentage = textAfterNickname
        .slice(0, percentageMatch.index)
        .trim();

      const numberMatches =
        beforePercentage.match(/\b\d{1,3}\b/g);

      if (numberMatches && numberMatches.length) {
        const lastNumber =
          numberMatches[numberMatches.length - 1];

        const level = Number.parseInt(
          lastNumber,
          10
        );

        if (isValidPsnLevel(level)) {
          return level;
        }
      }
    }
  }

  /*
    Final fallback.

    The first standalone level followed by a percentage
    in the visible profile text is normally the profile header.
  */
  const generalMatch = visibleText.match(
    /\b(\d{1,3})\s+\d{1,3}(?:[.,]\d+)?%/
  );

  if (generalMatch && generalMatch[1]) {
    const level = Number.parseInt(
      generalMatch[1],
      10
    );

    if (isValidPsnLevel(level)) {
      return level;
    }
  }

  return 0;
}

async function fetchProfileHtml(nickname) {
  const profileUrl = getProfileUrl(nickname);

  const response = await fetch(profileUrl, {
    headers: REQUEST_HEADERS,
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Exophase returned HTTP ${response.status}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (
    !contentType
      .toLowerCase()
      .includes("text/html")
  ) {
    throw new Error(
      `Unexpected response type: ${contentType}`
    );
  }

  return response.text();
}

async function fetchPsnLevel(nickname) {
  const maximumAttempts = 3;

  for (
    let attempt = 1;
    attempt <= maximumAttempts;
    attempt++
  ) {
    try {
      const html = await fetchProfileHtml(
        nickname
      );

      const level = extractPsnLevel(
        html,
        nickname
      );

      if (level > 0) {
        console.log(
          `${nickname}: detected PSN level ${level}`
        );

        return level;
      }

      const visibleText =
        htmlToVisibleText(html);

      if (
        /private|no games have been played/i.test(
          visibleText
        )
      ) {
        console.log(
          `${nickname}: profile is private or empty`
        );

        return 0;
      }

      throw new Error(
        "PSN level was not found in profile page"
      );
    } catch (error) {
      console.log(
        `${nickname}: attempt ${attempt} failed: ` +
        error.message
      );

      if (attempt < maximumAttempts) {
        await sleep(attempt * 1500);
      }
    }
  }

  return 0;
}

async function loadNamesFromSheet() {
  const response = await fetch(csvUrl, {
    headers: REQUEST_HEADERS,
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Google Sheet returned HTTP ${response.status}`
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

  const names = [];
  const seen = new Set();

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

  return names;
}

function sortPlayers(players) {
  players.sort(function(a, b) {
    const levelA = Number(a.psnLevel || 0);
    const levelB = Number(b.psnLevel || 0);

    if (levelB !== levelA) {
      return levelB - levelA;
    }

    return String(a.name || "").localeCompare(
      String(b.name || ""),
      undefined,
      {
        sensitivity: "base"
      }
    );
  });
}

async function main() {
  console.log(
    "Loading player names from Google Sheets..."
  );

  const names = await loadNamesFromSheet();

  console.log(
    `Found ${names.length} unique players.`
  );

  const players = [];

  for (const nickname of names) {
    console.log("");
    console.log(`Processing ${nickname}...`);

    const psnLevel =
      await fetchPsnLevel(nickname);

    players.push({
      name: nickname,
      profileUrl: getProfileUrl(nickname),
      cardUrl: getCardUrl(nickname),
      psnLevel: psnLevel
    });

    /*
      Avoid sending all profile requests at once.
    */
    await sleep(1000);
  }

  sortPlayers(players);

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(players, null, 2),
    "utf8"
  );

  console.log("");
  console.log("Final ranking:");

  players.forEach(function(player, index) {
    console.log(
      `${index + 1}. ` +
      `${player.name}: ` +
      `${player.psnLevel}`
    );
  });

  console.log("");
  console.log(
    `Updated ${OUTPUT_FILE} with ` +
    `${players.length} players.`
  );
}

main().catch(function(error) {
  console.error(error);
  process.exit(1);
});
