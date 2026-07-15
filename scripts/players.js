const fs = require("fs");
const { chromium } = require("playwright");

const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

if (!csvUrl) {
  throw new Error("Missing GOOGLE_SHEET_CSV_URL");
}

const OUTPUT_FILE = "players.json";

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
    /https:\/\/card\.exophase\.com\/[0-9]+\/[0-9]+\.png/gi,
    /https:\/\/card\.exophase\.com\/psn\/[^"' <>\]]+\.png/gi
  ];

  for (const pattern of patterns) {
    const match = String(text).match(pattern);

    if (match && match[0]) {
      return match[0]
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&");
    }
  }

  return "";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function isValidLevel(value) {
  return (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 999
  );
}

function escapeRegExp(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function extractLevelFromVisibleText(text, nickname) {
  const normalized = normalizeText(text);
  const escapedNickname = escapeRegExp(nickname);

  /*
    Exophase header normally appears in this order:

    PikxelisLV
    316
    20.38%

    The whitespace can be spaces or line breaks.
  */
  const nicknamePattern = new RegExp(
    escapedNickname +
      "[\\s\\S]{0,120}?" +
      "\\b([0-9]{1,3})\\b" +
      "[\\s\\S]{0,50}?" +
      "\\b[0-9]{1,3}(?:[.,][0-9]+)?%",
    "i"
  );

  const nicknameMatch = normalized.match(
    nicknamePattern
  );

  if (nicknameMatch && nicknameMatch[1]) {
    const level = Number.parseInt(
      nicknameMatch[1],
      10
    );

    if (isValidLevel(level)) {
      return level;
    }
  }

  /*
    More restrictive line-based fallback.

    Find the nickname line and inspect only the next few lines.
  */
  const lines = normalized
    .split("\n")
    .map(function(line) {
      return line.trim();
    })
    .filter(Boolean);

  const nicknameIndex = lines.findIndex(
    function(line) {
      return (
        line.toLowerCase() ===
        nickname.toLowerCase()
      );
    }
  );

  if (nicknameIndex !== -1) {
    const nearbyText = lines
      .slice(
        nicknameIndex,
        nicknameIndex + 8
      )
      .join(" ");

    const nearbyMatch = nearbyText.match(
      new RegExp(
        escapedNickname +
          "\\s+(?:LVL\\s*)?" +
          "([0-9]{1,3})\\s+" +
          "[0-9]{1,3}(?:[.,][0-9]+)?%",
        "i"
      )
    );

    if (nearbyMatch && nearbyMatch[1]) {
      const level = Number.parseInt(
        nearbyMatch[1],
        10
      );

      if (isValidLevel(level)) {
        return level;
      }
    }
  }

  return 0;
}

async function loadNamesFromSheet() {
  const response = await fetch(csvUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 PSN Player Cards Updater"
    }
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
      "Google Sheet does not contain any player rows"
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
    const contents = fs.readFileSync(
      OUTPUT_FILE,
      "utf8"
    );

    const players = JSON.parse(contents);
    const map = new Map();

    if (!Array.isArray(players)) {
      return map;
    }

    for (const player of players) {
      if (!player || !player.name) {
        continue;
      }

      map.set(
        String(player.name).toLowerCase(),
        player
      );
    }

    return map;
  } catch (error) {
    console.log(
      `Could not read existing players.json: ${error.message}`
    );

    return new Map();
  }
}

async function acceptCookieBanner(page) {
  const buttonNames = [
    /accept all/i,
    /accept/i,
    /agree/i,
    /allow all/i
  ];

  for (const buttonName of buttonNames) {
    const button = page
      .getByRole("button", {
        name: buttonName
      })
      .first();

    try {
      if (
        await button.isVisible({
          timeout: 1000
        })
      ) {
        await button.click({
          timeout: 3000
        });

        await page.waitForTimeout(500);

        return;
      }
    } catch (error) {
      // Banner was not present.
    }
  }
}

async function readPlayerProfile(
  context,
  nickname
) {
  const profileUrl = getProfileUrl(nickname);
  const page = await context.newPage();

  try {
    console.log(
      `${nickname}: opening ${profileUrl}`
    );

    const response = await page.goto(
      profileUrl,
      {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }
    );

    if (!response) {
      throw new Error(
        "Browser did not receive a response"
      );
    }

    if (!response.ok()) {
      throw new Error(
        `Exophase returned HTTP ${response.status()}`
      );
    }

    await acceptCookieBanner(page);

    /*
      Give Exophase client-side scripts time to populate
      the visible profile header.
    */
    await page.waitForTimeout(2500);

    await page
      .locator("body")
      .waitFor({
        state: "visible",
        timeout: 15000
      });

    const title = await page.title();
    const visibleText = await page
      .locator("body")
      .innerText({
        timeout: 15000
      });

    const normalizedText =
      normalizeText(visibleText);

    if (
      /just a moment|checking your browser|verify you are human/i.test(
        title + " " + normalizedText
      )
    ) {
      throw new Error(
        "Exophase displayed a browser verification page"
      );
    }

    if (
      /access denied|temporarily blocked|too many requests/i.test(
        normalizedText
      )
    ) {
      throw new Error(
        "Exophase blocked the request"
      );
    }

    const psnLevel =
      extractLevelFromVisibleText(
        normalizedText,
        nickname
      );

    if (!psnLevel) {
      const debugFile =
        "debug-" +
        nickname.replace(
          /[^a-zA-Z0-9_-]/g,
          "_"
        ) +
        ".txt";

      fs.writeFileSync(
        debugFile,
        normalizedText,
        "utf8"
      );

      await page.screenshot({
        path:
          "debug-" +
          nickname.replace(
            /[^a-zA-Z0-9_-]/g,
            "_"
          ) +
          ".png",
        fullPage: false
      });

      throw new Error(
        "Could not find PSN level in visible profile text"
      );
    }

    let cardUrl = "";

    const pageHtml = await page.content();

    cardUrl = extractCardUrl(pageHtml);

    if (!cardUrl) {
      const imageSources = await page
        .locator("img")
        .evaluateAll(function(images) {
          return images
            .map(function(image) {
              return image.currentSrc || image.src || "";
            })
            .filter(Boolean);
        });

      cardUrl = imageSources.find(
        function(source) {
          return source.includes(
            "card.exophase.com"
          );
        }
      ) || "";
    }

    if (!cardUrl) {
      cardUrl =
        getFallbackCardUrl(nickname);
    }

    console.log(
      `${nickname}: detected PSN level ${psnLevel}`
    );

    return {
      level: psnLevel,
      cardUrl: cardUrl
    };
  } finally {
    await page.close();
  }
}

async function readPlayerWithRetries(
  context,
  nickname
) {
  const maximumAttempts = 3;

  for (
    let attempt = 1;
    attempt <= maximumAttempts;
    attempt++
  ) {
    try {
      return await readPlayerProfile(
        context,
        nickname
      );
    } catch (error) {
      console.log(
        `${nickname}: attempt ${attempt} failed: ` +
        error.message
      );

      if (attempt < maximumAttempts) {
        await sleep(attempt * 3000);
      }
    }
  }

  return {
    level: 0,
    cardUrl: getFallbackCardUrl(nickname)
  };
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

  const existingPlayers =
    loadExistingPlayers();

  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    locale: "en-US",

    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36",

    viewport: {
      width: 1440,
      height: 1000
    },

    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const players = [];
  let detectedCount = 0;

  try {
    for (const nickname of names) {
      console.log("");
      console.log(
        `Processing ${nickname}...`
      );

      const result =
        await readPlayerWithRetries(
          context,
          nickname
        );

      let psnLevel = result.level;

      if (psnLevel > 0) {
        detectedCount++;
      } else {
        const existingPlayer =
          existingPlayers.get(
            nickname.toLowerCase()
          );

        const oldLevel = Number(
          existingPlayer &&
          existingPlayer.psnLevel
        );

        /*
          Preserve the old value only if it looks plausible.

          Do not reuse the corrupted small OCR values that were
          previously written as 2, 3, 5 and similar.
        */
        if (
          Number.isInteger(oldLevel) &&
          oldLevel >= 100 &&
          oldLevel <= 999
        ) {
          psnLevel = oldLevel;

          console.log(
            `${nickname}: using previous level ${oldLevel}`
          );
        }
      }

      players.push({
        name: nickname,
        profileUrl: getProfileUrl(
          nickname
        ),
        cardUrl: result.cardUrl,
        psnLevel: psnLevel
      });

      /*
        Keep the requests slow and sequential.
      */
      await sleep(2500);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log("");
  console.log(
    `Successfully detected ${detectedCount} of ${names.length} levels.`
  );

  /*
    Do not replace players.json if browser access failed
    for most players.
  */
  const minimumDetected = Math.ceil(
    names.length * 0.7
  );

  if (detectedCount < minimumDetected) {
    throw new Error(
      `Only ${detectedCount} of ${names.length} levels ` +
      "were detected. players.json was not overwritten. " +
      "Check the debug files in the workflow artifacts."
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
