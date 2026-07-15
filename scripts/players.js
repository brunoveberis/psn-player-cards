const fs = require("fs");
const sharp = require("sharp");
const { createWorker, PSM } = require("tesseract.js");

const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

if (!csvUrl) {
  throw new Error("Missing GOOGLE_SHEET_CSV_URL");
}

const OUTPUT_FILE = "players.json";

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 GitHubAction PSN Player Cards",
  Accept: "image/png,image/*;q=0.9,text/html;q=0.8,*/*;q=0.5"
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

async function tryGetGeneratedCardUrl(nickname) {
  const body = new URLSearchParams();

  body.set("top_platform", "psn");
  body.set("top_gamertag", nickname);
  body.set("top_show", "games");
  body.set("bottom_platform", "");
  body.set("bottom_gamertag", "");
  body.set("bottom_show", "games");

  const response = await fetch(
    "https://gamercards.exophase.com/",
    {
      method: "POST",
      headers: {
        ...REQUEST_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    }
  );

  if (!response.ok) {
    throw new Error(
      `Card generator returned HTTP ${response.status}`
    );
  }

  return extractCardUrl(await response.text());
}

async function tryGetCardFromProfilePage(nickname) {
  const response = await fetch(getProfileUrl(nickname), {
    headers: REQUEST_HEADERS
  });

  if (!response.ok) {
    throw new Error(
      `Profile returned HTTP ${response.status}`
    );
  }

  return extractCardUrl(await response.text());
}

async function getBestCardUrl(nickname) {
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

  try {
    const profileCardUrl =
      await tryGetCardFromProfilePage(nickname);

    if (profileCardUrl) {
      console.log(
        `Profile card URL for ${nickname}: ${profileCardUrl}`
      );

      return profileCardUrl;
    }
  } catch (error) {
    console.log(
      `Profile scan failed for ${nickname}: ${error.message}`
    );
  }

  const fallbackUrl = getFallbackCardUrl(nickname);

  console.log(
    `Using fallback card for ${nickname}: ${fallbackUrl}`
  );

  return fallbackUrl;
}

async function downloadCard(cardUrl) {
  const separator = cardUrl.includes("?") ? "&" : "?";

  const response = await fetch(
    cardUrl + separator + "cache=" + Date.now(),
    {
      headers: REQUEST_HEADERS
    }
  );

  if (!response.ok) {
    throw new Error(
      `Card returned HTTP ${response.status}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("image")) {
    throw new Error(
      `Card response was not an image: ${contentType}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

function getLevelCrop(metadata) {
  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read card dimensions");
  }

  /*
    Reference Exophase card dimensions: 425 x 142.

    The level number is located at:
    left: 214
    top: 5
    right: 250
    bottom: 35

    The coordinates are scaled when Exophase returns a card at
    a different resolution.
  */
  const scaleX = metadata.width / 425;
  const scaleY = metadata.height / 142;

  const left = Math.round(214 * scaleX);
  const top = Math.round(5 * scaleY);
  const right = Math.round(250 * scaleX);
  const bottom = Math.round(35 * scaleY);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.max(
      1,
      Math.min(metadata.width - left, right - left)
    ),
    height: Math.max(
      1,
      Math.min(metadata.height - top, bottom - top)
    )
  };
}

async function createOcrVariants(cardBuffer) {
  const metadata = await sharp(cardBuffer).metadata();
  const crop = getLevelCrop(metadata);

  console.log(
    `Card dimensions: ${metadata.width}x${metadata.height}`
  );

  console.log(
    `Level crop: left=${crop.left}, top=${crop.top}, ` +
    `width=${crop.width}, height=${crop.height}`
  );

  const resizeOptions = {
    width: 720,
    height: 600,
    fit: "fill",
    kernel: sharp.kernel.lanczos3
  };

  const padding = {
    top: 80,
    bottom: 80,
    left: 80,
    right: 80,
    background: "white"
  };

  const base = sharp(cardBuffer).extract(crop);

  const normal = await base
    .clone()
    .resize(resizeOptions)
    .grayscale()
    .normalize()
    .sharpen()
    .extend(padding)
    .png()
    .toBuffer();

  const contrast = await base
    .clone()
    .resize(resizeOptions)
    .grayscale()
    .normalize()
    .linear(2, -70)
    .sharpen()
    .extend(padding)
    .png()
    .toBuffer();

  const threshold120 = await base
    .clone()
    .resize(resizeOptions)
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(120)
    .extend(padding)
    .png()
    .toBuffer();

  const threshold145 = await base
    .clone()
    .resize(resizeOptions)
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(145)
    .extend(padding)
    .png()
    .toBuffer();

  const threshold170 = await base
    .clone()
    .resize(resizeOptions)
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(170)
    .extend(padding)
    .png()
    .toBuffer();

  const threshold195 = await base
    .clone()
    .resize(resizeOptions)
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(195)
    .extend(padding)
    .png()
    .toBuffer();

  const inverted = await base
    .clone()
    .resize(resizeOptions)
    .grayscale()
    .normalize()
    .negate()
    .sharpen()
    .threshold(145)
    .extend(padding)
    .png()
    .toBuffer();

  return [
    {
      name: "normal",
      buffer: normal
    },
    {
      name: "contrast",
      buffer: contrast
    },
    {
      name: "threshold-120",
      buffer: threshold120
    },
    {
      name: "threshold-145",
      buffer: threshold145
    },
    {
      name: "threshold-170",
      buffer: threshold170
    },
    {
      name: "threshold-195",
      buffer: threshold195
    },
    {
      name: "inverted",
      buffer: inverted
    }
  ];
}

function parseOcrLevel(text) {
  const cleaned = String(text || "")
    .replace(/\s/g, "")
    .replace(/[^0-9]/g, "");

  if (!/^[0-9]{1,3}$/.test(cleaned)) {
    return 0;
  }

  const level = Number.parseInt(cleaned, 10);

  if (
    !Number.isInteger(level) ||
    level < 1 ||
    level > 999
  ) {
    return 0;
  }

  return level;
}

async function recognizeVariant(worker, variant, nickname) {
  const result = await worker.recognize(variant.buffer);

  const rawText = String(result.data.text || "").trim();
  const level = parseOcrLevel(rawText);
  const confidence = Number(result.data.confidence || 0);

  console.log(
    `${nickname} ${variant.name}: ` +
    `"${rawText}" => ${level || "not detected"} ` +
    `(confidence ${confidence.toFixed(1)})`
  );

  return {
    level: level,
    confidence: confidence
  };
}

function chooseLevel(results) {
  const validResults = results.filter(function(result) {
    return result.level >= 1 && result.level <= 999;
  });

  if (!validResults.length) {
    return 0;
  }

  const candidates = new Map();

  for (const result of validResults) {
    if (!candidates.has(result.level)) {
      candidates.set(result.level, {
        level: result.level,
        votes: 0,
        totalConfidence: 0,
        bestConfidence: 0
      });
    }

    const candidate = candidates.get(result.level);

    candidate.votes++;
    candidate.totalConfidence += result.confidence;
    candidate.bestConfidence = Math.max(
      candidate.bestConfidence,
      result.confidence
    );
  }

  const ranked = Array.from(candidates.values())
    .sort(function(a, b) {
      if (b.votes !== a.votes) {
        return b.votes - a.votes;
      }

      if (b.totalConfidence !== a.totalConfidence) {
        return b.totalConfidence - a.totalConfidence;
      }

      return b.bestConfidence - a.bestConfidence;
    });

  console.log("OCR candidates:");

  ranked.forEach(function(candidate) {
    console.log(
      `  ${candidate.level}: ${candidate.votes} votes, ` +
      `best confidence ${candidate.bestConfidence.toFixed(1)}`
    );
  });

  const best = ranked[0];

  if (best.votes >= 2) {
    return best.level;
  }

  if (best.bestConfidence >= 80) {
    return best.level;
  }

  return 0;
}

async function readPsnLevel(cardBuffer, worker, nickname) {
  const variants = await createOcrVariants(cardBuffer);
  const results = [];

  for (const variant of variants) {
    try {
      results.push(
        await recognizeVariant(
          worker,
          variant,
          nickname
        )
      );
    } catch (error) {
      console.log(
        `OCR ${variant.name} failed for ${nickname}: ` +
        error.message
      );
    }
  }

  return chooseLevel(results);
}

async function loadNamesFromSheet() {
  const response = await fetch(csvUrl, {
    headers: REQUEST_HEADERS
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

function sleep(milliseconds) {
  return new Promise(function(resolve) {
    setTimeout(resolve, milliseconds);
  });
}

async function main() {
  console.log("Loading players from Google Sheets...");

  const names = await loadNamesFromSheet();

  console.log(`Found ${names.length} unique players.`);

  const worker = await createWorker("eng");

  await worker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: PSM.SINGLE_WORD,
    preserve_interword_spaces: "0",
    user_defined_dpi: "300"
  });

  const players = [];

  try {
    for (const nickname of names) {
      console.log("");
      console.log(`Processing ${nickname}...`);

      const cardUrl = await getBestCardUrl(nickname);

      let psnLevel = 0;

      try {
        const cardBuffer = await downloadCard(cardUrl);

        psnLevel = await readPsnLevel(
          cardBuffer,
          worker,
          nickname
        );
      } catch (error) {
        console.log(
          `Could not read level for ${nickname}: ` +
          error.message
        );
      }

      players.push({
        name: nickname,
        profileUrl: getProfileUrl(nickname),
        cardUrl: cardUrl,
        psnLevel: psnLevel
      });

      console.log(
        `Final level for ${nickname}: ${psnLevel}`
      );

      await sleep(800);
    }
  } finally {
    await worker.terminate();
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
      `${index + 1}. ${player.name}: ${player.psnLevel}`
    );
  });

  console.log("");
  console.log(
    `Updated ${OUTPUT_FILE} with ${players.length} players.`
  );
}

main().catch(function(error) {
  console.error(error);
  process.exit(1);
});
