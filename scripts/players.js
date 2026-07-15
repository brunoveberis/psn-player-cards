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

  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache"
};

function sleep(milliseconds) {
  return new Promise(function(resolve) {
    setTimeout(resolve, milliseconds);
  });
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

function getCardUrl(nickname) {
  return (
    "https://card.exophase.com/psn/" +
    encodeURIComponent(nickname) +
    ".png"
  );
}

function escapeRegExp(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
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

  return String(text || "").replace(
    /&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    function(match, entity) {
      const normalized = entity.toLowerCase();

      if (
        Object.prototype.hasOwnProperty.call(
          namedEntities,
          normalized
        )
      ) {
        return namedEntities[normalized];
      }

      if (normalized.startsWith("#x")) {
        const code = Number.parseInt(
          normalized.slice(2),
          16
        );

        return Number.isFinite(code)
          ? String.fromCodePoint(code)
          : " ";
      }

      if (normalized.startsWith("#")) {
        const code = Number.parseInt(
          normalized.slice(1),
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

function htmlToText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style\b[^>]*>[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
        " "
      )
      .replace(
        /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
        " "
      )
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(?:div|p|h1|h2|h3|li|section)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function isValidLevel(level) {
  return (
    Number.isInteger(level) &&
    level >= 1 &&
    level <= 999
  );
}

function extractLevelFromProfile(html, nickname) {
  const text = htmlToText(html);
  const escapedNickname = escapeRegExp(nickname);

  /*
    Expected Exophase profile header:

    nickname 316 20.38%

    Only allow a short distance between these values. This prevents
    numbers such as "3,634 hours" from being mistaken for the level.
  */
  const exactHeaderPattern = new RegExp(
    "(?:^|\\s)" +
      escapedNickname +
      "\\s+(\\d{1,3})\\s+" +
      "(\\d{1,3}(?:[.,]\\d{1,2})?)%",
    "ig"
  );

  const exactMatches = Array.from(
    text.matchAll(exactHeaderPattern)
  );

  for (const match of exactMatches) {
    const level = Number.parseInt(match[1], 10);

    if (isValidLevel(level)) {
      return {
        level: level,
        progress: match[2],
        method: "exact-header"
      };
    }
  }

  /*
    Restricted fallback:

    Find every occurrence of the nickname. Examine no more than
    100 characters after it. The first two values must be:

    level percentage
  */
  const lowerText = text.toLowerCase();
  const lowerNickname = nickname.toLowerCase();

  let searchPosition = 0;

  while (searchPosition < lowerText.length) {
    const nicknameIndex = lowerText.indexOf(
      lowerNickname,
      searchPosition
    );

    if (nicknameIndex === -1) {
      break;
    }

    const afterNickname = text
      .slice(
        nicknameIndex + nickname.length,
        nicknameIndex + nickname.length + 100
      )
      .trim();

    const localMatch = afterNickname.match(
      /^(\d{1,3})\s+(\d{1,3}(?:[.,]\d{1,2})?)%/
    );

    if (localMatch) {
      const level = Number.parseInt(
        localMatch[1],
        10
      );

      if (isValidLevel(level)) {
        return {
          level: level,
          progress: localMatch[2],
          method: "restricted-header"
        };
      }
    }

    searchPosition =
      nicknameIndex + nickname.length;
  }

  return {
    level: 0,
    progress: "",
    method: "not-found"
  };
}

async function fetchProfileHtml(nickname) {
  const profileUrl = getProfileUrl(nickname);

  const response = await fetch(
    profileUrl + "?cache=" + Date.now(),
    {
      headers: REQUEST_HEADERS,
      redirect: "follow"
    }
  );

  if (!response.ok) {
    throw new Error(
      `Exophase returned HTTP ${response.status}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (
    !contentType.toLowerCase().includes("text/html")
  ) {
    throw new Error(
      `Unexpected content type: ${contentType}`
    );
  }

  const html = await response.text();

  if (!html || html.length < 500) {
    throw new Error(
      "Exophase returned an unexpectedly short page"
    );
  }

  return html;
}

async function getPsnLevel(nickname) {
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

      const result = extractLevelFromProfile(
        html,
        nickname
      );

      if (result.level > 0) {
        console.log(
          `${nickname}: level ${result.level}, ` +
          `progress ${result.progress}%, ` +
          `method ${result.method}`
        );

        return result.level;
      }

      console.log(
        `${nickname}: profile header was not found`
      );
    } catch (error) {
      console.log(
        `${nickname}: attempt ${attempt} failed: ` +
        error.message
      );
    }

    if (attempt < maximumAttempts) {
      await sleep(attempt * 1500);
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

  if (lines.length < 2) {
    throw new Error(
      "Google Sheet does not contain player rows"
    );
  }

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

function loadExistingPlayers() {
  if (!fs.existsSync(OUTPUT_FILE)) {
    return new Map();
  }

  try {
    const existing = JSON.parse(
      fs.readFileSync(OUTPUT_FILE, "utf8")
    );

    if (!Array.isArray(existing)) {
      return new Map();
    }

    const map = new Map();

    existing.forEach(function(player) {
      if (!player || !player.name) {
        return;
      }

      map.set(
        String(player.name).toLowerCase(),
        player
      );
    });

    return map;
  } catch (error) {
    console.log(
      `Could not read existing ${OUTPUT_FILE}: ` +
      error.message
    );

    return new Map();
  }
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

async function runValidationCheck() {
  console.log(
    "Running Exophase parser validation..."
  );

  const validationNickname = "PikxelisLV";
  const expectedLevel = 316;

  const html = await fetchProfileHtml(
    validationNickname
  );

  const result = extractLevelFromProfile(
    html,
    validationNickname
  );

  console.log(
    `Validation result: ${validationNickname} ` +
    `returned ${result.level}`
  );

  if (result.level !== expectedLevel) {
    throw new Error(
      "Validation failed. Expected PikxelisLV level " +
      `${expectedLevel}, received ${result.level}. ` +
      "players.json was not changed."
    );
  }

  console.log("Validation passed.");
}

async function main() {
  /*
    Do not touch players.json unless the parser first proves
    that it can read a known live profile correctly.
  */
  await runValidationCheck();

  console.log("");
  console.log(
    "Loading player names from Google Sheets..."
  );

  const names = await loadNamesFromSheet();

  console.log(
    `Found ${names.length} unique players.`
  );

  const existingPlayers =
    loadExistingPlayers();

  const players = [];
  let detectedCount = 0;
  let failedCount = 0;

  for (const nickname of names) {
    console.log("");
    console.log(`Processing ${nickname}...`);

    const detectedLevel =
      await getPsnLevel(nickname);

    let psnLevel = detectedLevel;

    if (detectedLevel > 0) {
      detectedCount++;
    } else {
      failedCount++;

      const previousPlayer =
        existingPlayers.get(
          nickname.toLowerCase()
        );

      /*
        Reuse an old value only when it looks realistic.

        Values below 50 are not reused because the previous OCR
        script filled many profiles with fragments such as 2, 3,
        5, 8, 10, 23 and 33.
      */
      const previousLevel = Number(
        previousPlayer &&
        previousPlayer.psnLevel
      );

      if (
        Number.isInteger(previousLevel) &&
        previousLevel >= 50 &&
        previousLevel <= 999
      ) {
        psnLevel = previousLevel;

        console.log(
          `${nickname}: using previous reliable ` +
          `level ${previousLevel}`
        );
      } else {
        psnLevel = 0;

        console.log(
          `${nickname}: no reliable level available`
        );
      }
    }

    players.push({
      name: nickname,
      profileUrl: getProfileUrl(nickname),
      cardUrl: getCardUrl(nickname),
      psnLevel: psnLevel
    });

    await sleep(1000);
  }

  console.log("");
  console.log(
    `Detected levels: ${detectedCount}`
  );

  console.log(
    `Undetected profiles: ${failedCount}`
  );

  /*
    If Exophase blocks most requests or changes its page,
    stop instead of publishing a broken alphabetical ranking.
  */
  const requiredSuccessCount = Math.ceil(
    names.length * 0.75
  );

  if (detectedCount < requiredSuccessCount) {
    throw new Error(
      `Only ${detectedCount} of ${names.length} levels ` +
      "were detected. players.json was not overwritten."
    );
  }

  sortPlayers(players);

  const temporaryFile =
    OUTPUT_FILE + ".tmp";

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(players, null, 2),
    "utf8"
  );

  fs.renameSync(
    temporaryFile,
    OUTPUT_FILE
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
  console.error("");
  console.error("Update failed:");
  console.error(error.message);
  process.exit(1);
});
