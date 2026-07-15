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
    const generatedUrl =
      await tryGetGeneratedCardUrl(nickname);

    if (generatedUrl) {
      console.log(
        `Generated card for ${nickname}: ${generatedUrl}`
      );

      return generatedUrl;
    }
  } catch (error) {
    console.log(
      `Generator failed for ${nickname}: ${error.message}`
    );
  }

  try {
    const profileUrl =
      await tryGetCardFromProfilePage(nickname);

    if (profileUrl) {
      console.log(
        `Profile card for ${nickname}: ${profileUrl}`
      );

      return profileUrl;
    }
  } catch (error) {
    console.log(
      `Profile scan failed for ${nickname}: ${error.message}`
    );
  }

  return getFallbackCardUrl(nickname);
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
      `Card returned HTTP ${response.status}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("image")) {
    throw new Error(
      `Card response is not an image: ${contentType}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

function cleanRecognizedLevel(text) {
  const cleaned = String(text || "")
    .replace(/[OoQ]/g, "0")
    .replace(/[Il|!]/g, "1")
    .replace(/[Zz]/g, "2")
    .replace(/[Ss]/g, "5")
    .replace(/[Bb]/g, "8")
    .replace(/[^0-9]/g, "");

  if (!cleaned) {
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

function createCropRegions(width, height) {
  /*
    The PSN trophy level is at the upper-left of the card.

    The star icon sits first, and the number is immediately to
    its right. These regions deliberately exclude most of the
    star so OCR sees only the level number.

    Several nearby regions are tested because Exophase cards
    can have slightly different dimensions or layouts.
  */
  return [
    {
      name: "level-main",
      left: 0.105,
      top: 0.025,
      width: 0.165,
      height: 0.17
    },
    {
      name: "level-wide",
      left: 0.09,
      top: 0.015,
      width: 0.21,
      height: 0.19
    },
    {
      name: "level-lower",
      left: 0.105,
      top: 0.045,
      width: 0.17,
      height: 0.17
    },
    {
      name: "level-narrow",
      left: 0.12,
      top: 0.025,
      width: 0.145,
      height: 0.16
    }
  ].map(function(region) {
    const left = Math.max(
      0,
      Math.round(width * region.left)
    );

    const top = Math.max(
      0,
      Math.round(height * region.top)
    );

    const cropWidth = Math.max(
      25,
      Math.min(
        width - left,
        Math.round(width * region.width)
      )
    );

    const cropHeight = Math.max(
      18,
      Math.min(
        height - top,
        Math.round(height * region.height)
      )
    );

    return {
      name: region.name,
      left: left,
      top: top,
      width: cropWidth,
      height: cropHeight
    };
  });
}

async function createOcrImages(cardBuffer) {
  const metadata = await sharp(cardBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not determine card dimensions");
  }

  console.log(
    `Card dimensions: ${metadata.width}x${metadata.height}`
  );

  const regions = createCropRegions(
    metadata.width,
    metadata.height
  );

  const images = [];

  for (const region of regions) {
    const crop = sharp(cardBuffer).extract({
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height
    });

    const outputWidth = Math.max(
      500,
      region.width * 8
    );

    const normal = await crop
      .clone()
      .resize({
        width: outputWidth,
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();

    const threshold150 = await crop
      .clone()
      .resize({
        width: outputWidth,
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(150)
      .png()
      .toBuffer();

    const threshold180 = await crop
      .clone()
      .resize({
        width: outputWidth,
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(180)
      .png()
      .toBuffer();

    const inverted = await crop
      .clone()
      .resize({
        width: outputWidth,
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .negate()
      .sharpen()
      .threshold(150)
      .png()
      .toBuffer();

    images.push({
      name: region.name + "-normal",
      buffer: normal
    });

    images.push({
      name: region.name + "-threshold-150",
      buffer: threshold150
    });

    images.push({
      name: region.name + "-threshold-180",
      buffer: threshold180
    });

    images.push({
      name: region.name + "-inverted",
      buffer: inverted
    });
  }

  return images;
}

async function recognizeImage(worker, image, nickname) {
  const result = await worker.recognize(image.buffer);

  const rawText = String(result.data.text || "").trim();
  const level = cleanRecognizedLevel(rawText);
  const confidence = Number(result.data.confidence || 0);

  console.log(
    `${nickname} ${image.name}: ` +
    `"${rawText}" => ${level || "none"} ` +
    `(confidence ${confidence.toFixed(1)})`
  );

  return {
    level: level,
    confidence: confidence,
    region: image.name
  };
}

function chooseBestLevel(results) {
  const validResults = results.filter(function(result) {
    return result.level >= 1 && result.level <= 999;
  });

  if (!validResults.length) {
    return 0;
  }

  const grouped = new Map();

  for (const result of validResults) {
    if (!grouped.has(result.level)) {
      grouped.set(result.level, {
        level: result.level,
        count: 0,
        totalConfidence: 0,
        bestConfidence: 0
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
      if (b.count !== a.count) {
        return b.count - a.count;
      }

      if (b.totalConfidence !== a.totalConfidence) {
        return b.totalConfidence - a.totalConfidence;
      }

      return b.bestConfidence - a.bestConfidence;
    });

  /*
    Require either:
    1. The same result from at least two OCR attempts, or
    2. One unusually confident result.

    This prevents random trophy counts or visual fragments
    from being stored as the player's PSN level.
  */
  const best = ranked[0];

  if (
    best.count >= 2 ||
    best.bestConfidence >= 75
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
  const images = await createOcrImages(cardBuffer);
  const results = [];

  for (const image of images) {
    try {
      const result = await recognizeImage(
        worker,
        image,
        nickname
      );

      if (result.level > 0) {
        results.push(result);
      }
    } catch (error) {
      console.log(
        `OCR failed for ${nickname} ` +
        `${image.name}: ${error.message}`
      );
    }
  }

  return chooseBestLevel(results);
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
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
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

      if (psnLevel > 0) {
        console.log(
          `Final PSN level for ${nickname}: ${psnLevel}`
        );
      } else {
        console.log(
          `PSN level not detected for ${nickname}`
        );
      }

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
  console.log(
    `Updated players.json with ${players.length} players.`
  );
}

main().catch(function(error) {
  console.error(error);
  process.exit(1);
});
