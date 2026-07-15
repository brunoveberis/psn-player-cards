const fs = require("fs");
const sharp = require("sharp");
const { createWorker, PSM } = require("tesseract.js");

const csvUrl = process.env.GOOGLE_SHEET_CSV_URL;

if (!csvUrl) {
  throw new Error("Missing GOOGLE_SHEET_CSV_URL");
}

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

  const html = await response.text();

  return extractCardUrl(html);
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

  const html = await response.text();

  return extractCardUrl(html);
}

async function getBestCardUrl(nickname) {
  try {
    const generatedCardUrl =
      await tryGetGeneratedCardUrl(nickname);

    if (generatedCardUrl) {
      console.log(
        `Generated card for ${nickname}: ${generatedCardUrl}`
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
        `Profile card for ${nickname}: ${profileCardUrl}`
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

async function downloadImage(url) {
  const separator = url.includes("?") ? "&" : "?";

  const response = await fetch(
    url + separator + "cache=" + Date.now(),
    {
      headers: REQUEST_HEADERS
    }
  );

  if (!response.ok) {
    throw new Error(
      `Card image returned HTTP ${response.status}`
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

function normalizeOcrText(text) {
  return String(text || "")
    .replace(/[OoQ]/g, "0")
    .replace(/[Il|!]/g, "1")
    .replace(/[Zz]/g, "2")
    .replace(/[Ss]/g, "5")
    .replace(/[Bb]/g, "8")
    .replace(/[^0-9]/g, "");
}

function parseLevel(text) {
  const digits = normalizeOcrText(text);

  if (!digits) {
    return 0;
  }

  /*
    The crop should contain only the level. If OCR produces extra
    digits, take the first plausible group of up to three digits.
  */
  const matches = digits.match(/[0-9]{1,3}/g);

  if (!matches) {
    return 0;
  }

  for (const match of matches) {
    const level = Number.parseInt(match, 10);

    if (
      Number.isInteger(level) &&
      level >= 1 &&
      level <= 999
    ) {
      return level;
    }
  }

  return 0;
}

function createLevelRegions(imageWidth, imageHeight) {
  /*
    The level number sits immediately to the right of the yellow
    trophy-level icon.

    These narrow regions deliberately start after the icon.
    The previous versions started too far left and OCR interpreted
    the icon itself as numbers such as 3, 5, 7, 41 or 74.
  */
  const regions = [
    {
      name: "exact",
      left: 0.542,
      top: 0.055,
      width: 0.075,
      height: 0.125
    },
    {
      name: "left-2",
      left: 0.536,
      top: 0.055,
      width: 0.082,
      height: 0.125
    },
    {
      name: "right-2",
      left: 0.548,
      top: 0.055,
      width: 0.072,
      height: 0.125
    },
    {
      name: "higher",
      left: 0.542,
      top: 0.042,
      width: 0.078,
      height: 0.14
    },
    {
      name: "lower",
      left: 0.542,
      top: 0.065,
      width: 0.078,
      height: 0.125
    },
    {
      name: "slightly-wide",
      left: 0.532,
      top: 0.045,
      width: 0.09,
      height: 0.145
    }
  ];

  return regions.map(function(region) {
    const left = Math.max(
      0,
      Math.round(imageWidth * region.left)
    );

    const top = Math.max(
      0,
      Math.round(imageHeight * region.top)
    );

    const width = Math.max(
      20,
      Math.min(
        imageWidth - left,
        Math.round(imageWidth * region.width)
      )
    );

    const height = Math.max(
      16,
      Math.min(
        imageHeight - top,
        Math.round(imageHeight * region.height)
      )
    );

    return {
      name: region.name,
      left: left,
      top: top,
      width: width,
      height: height
    };
  });
}

async function makeOcrVariants(cardBuffer) {
  const metadata = await sharp(cardBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not determine card dimensions");
  }

  console.log(
    `Card dimensions: ${metadata.width}x${metadata.height}`
  );

  const regions = createLevelRegions(
    metadata.width,
    metadata.height
  );

  const variants = [];

  for (const region of regions) {
    const baseCrop = sharp(cardBuffer).extract({
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height
    });

    const targetWidth = Math.max(
      600,
      region.width * 14
    );

    const normal = await baseCrop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();

    const highContrast = await baseCrop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .linear(2.2, -90)
      .sharpen()
      .png()
      .toBuffer();

    const threshold140 = await baseCrop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(140)
      .png()
      .toBuffer();

    const threshold170 = await baseCrop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(170)
      .png()
      .toBuffer();

    const threshold200 = await baseCrop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(200)
      .png()
      .toBuffer();

    const inverted = await baseCrop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .negate()
      .sharpen()
      .threshold(155)
      .png()
      .toBuffer();

    variants.push({
      name: region.name + "-normal",
      buffer: normal
    });

    variants.push({
      name: region.name + "-contrast",
      buffer: highContrast
    });

    variants.push({
      name: region.name + "-threshold-140",
      buffer: threshold140
    });

    variants.push({
      name: region.name + "-threshold-170",
      buffer: threshold170
    });

    variants.push({
      name: region.name + "-threshold-200",
      buffer: threshold200
    });

    variants.push({
      name: region.name + "-inverted",
      buffer: inverted
    });
  }

  return variants;
}

async function recognizeVariant(
  worker,
  variant,
  nickname
) {
  const result = await worker.recognize(variant.buffer);

  const rawText = String(result.data.text || "").trim();
  const level = parseLevel(rawText);
  const confidence = Number(result.data.confidence || 0);

  console.log(
    `${nickname} ${variant.name}: ` +
    `"${rawText}" => ${level || "none"} ` +
    `(confidence ${confidence.toFixed(1)})`
  );

  return {
    level: level,
    confidence: confidence,
    variantName: variant.name
  };
}

function chooseBestLevel(results) {
  const valid = results.filter(function(result) {
    return (
      Number.isInteger(result.level) &&
      result.level >= 1 &&
      result.level <= 999
    );
  });

  if (!valid.length) {
    return 0;
  }

  const grouped = new Map();

  for (const result of valid) {
    if (!grouped.has(result.level)) {
      grouped.set(result.level, {
        level: result.level,
        count: 0,
        totalConfidence: 0,
        bestConfidence: 0,
        threeDigitBonus: result.level >= 100 ? 1 : 0
      });
    }

    const group = grouped.get(result.level);

    group.count++;
    group.totalConfidence += result.confidence;
    group.bestConfidence = Math.max(
      group.bestConfidence,
      result.confidence
    );
  }

  const ranked = Array.from(grouped.values())
    .sort(function(a, b) {
      /*
        Agreement between multiple crops is the strongest signal.
      */
      if (b.count !== a.count) {
        return b.count - a.count;
      }

      /*
        When OCR sees both a complete three-digit number and a
        fragment such as 5 or 74, prefer the complete result.
      */
      if (b.threeDigitBonus !== a.threeDigitBonus) {
        return b.threeDigitBonus - a.threeDigitBonus;
      }

      if (b.totalConfidence !== a.totalConfidence) {
        return b.totalConfidence - a.totalConfidence;
      }

      if (b.bestConfidence !== a.bestConfidence) {
        return b.bestConfidence - a.bestConfidence;
      }

      return b.level - a.level;
    });

  console.log("OCR candidates:");

  ranked.forEach(function(candidate) {
    console.log(
      `  ${candidate.level}: ` +
      `${candidate.count} matches, ` +
      `total confidence ${candidate.totalConfidence.toFixed(1)}, ` +
      `best confidence ${candidate.bestConfidence.toFixed(1)}`
    );
  });

  const best = ranked[0];

  /*
    Require agreement from at least two image variants.

    A single OCR guess is not safe enough for ranking because
    a trophy icon or background texture can look like a digit.
  */
  if (best.count >= 2) {
    return best.level;
  }

  /*
    Permit one very confident three-digit result as a fallback.
  */
  if (
    best.level >= 100 &&
    best.bestConfidence >= 85
  ) {
    return best.level;
  }

  return 0;
}

async function readPsnLevel(
  cardBuffer,
  worker,
  nickname
) {
  const variants = await makeOcrVariants(cardBuffer);
  const results = [];

  for (const variant of variants) {
    try {
      const result = await recognizeVariant(
        worker,
        variant,
        nickname
      );

      if (result.level > 0) {
        results.push(result);
      }
    } catch (error) {
      console.log(
        `OCR failed for ${nickname} ` +
        `${variant.name}: ${error.message}`
      );
    }
  }

  const level = chooseBestLevel(results);

  console.log(
    `Selected PSN level for ${nickname}: ${level || "not detected"}`
  );

  return level;
}

function sleep(milliseconds) {
  return new Promise(function(resolve) {
    setTimeout(resolve, milliseconds);
  });
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

async function main() {
  console.log("Loading names from Google Sheets...");

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
        const cardBuffer = await downloadImage(cardUrl);

        psnLevel = await readPsnLevel(
          cardBuffer,
          worker,
          nickname
        );
      } catch (error) {
        console.log(
          `Could not process ${nickname}: ${error.message}`
        );
      }

      players.push({
        name: nickname,
        profileUrl: getProfileUrl(nickname),
        cardUrl: cardUrl,
        psnLevel: psnLevel
      });

      await sleep(1000);
    }
  } finally {
    await worker.terminate();
  }

  sortPlayers(players);

  fs.writeFileSync(
    "players.json",
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
    `Updated players.json with ${players.length} players.`
  );
}

main().catch(function(error) {
  console.error(error);
  process.exit(1);
});
