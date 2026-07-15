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

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

function cleanRecognizedLevel(text) {
  const source = String(text || "")
    .replace(/[OoQ]/g, "0")
    .replace(/[Il|!]/g, "1")
    .replace(/[Zz]/g, "2")
    .replace(/[Ss]/g, "5")
    .replace(/[Bb]/g, "8");

  const matches = source.match(/\d{1,3}/g);

  if (!matches || !matches.length) {
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

function getLevelCropRegions(imageWidth, imageHeight) {
  /*
    The PSN trophy level appears in the top bar, slightly right
    of the horizontal center of the Exophase card.

    These crops focus on the number to the right of the yellow
    trophy-level icon. They avoid the username, trophy total,
    games total and progress percentage.
  */
  const percentageRegions = [
    {
      name: "main",
      left: 0.505,
      top: 0.035,
      width: 0.105,
      height: 0.19
    },
    {
      name: "slightly-left",
      left: 0.485,
      top: 0.025,
      width: 0.13,
      height: 0.21
    },
    {
      name: "slightly-right",
      left: 0.52,
      top: 0.025,
      width: 0.10,
      height: 0.21
    },
    {
      name: "wide",
      left: 0.475,
      top: 0.015,
      width: 0.16,
      height: 0.23
    },
    {
      name: "lower",
      left: 0.50,
      top: 0.055,
      width: 0.12,
      height: 0.18
    }
  ];

  return percentageRegions.map(function(region) {
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
      18,
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

async function createOcrImages(cardBuffer) {
  const metadata = await sharp(cardBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not determine card dimensions");
  }

  console.log(
    `Card dimensions: ${metadata.width}x${metadata.height}`
  );

  const cropRegions = getLevelCropRegions(
    metadata.width,
    metadata.height
  );

  const images = [];

  for (const region of cropRegions) {
    const crop = sharp(cardBuffer).extract({
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height
    });

    const targetWidth = Math.max(
      700,
      region.width * 12
    );

    const normal = await crop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen({
        sigma: 1.5
      })
      .png()
      .toBuffer();

    const contrast = await crop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .linear(2.5, -100)
      .sharpen({
        sigma: 1.5
      })
      .png()
      .toBuffer();

    const threshold130 = await crop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(130)
      .png()
      .toBuffer();

    const threshold160 = await crop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(160)
      .png()
      .toBuffer();

    const threshold190 = await crop
      .clone()
      .resize({
        width: targetWidth,
        kernel: sharp.kernel.lanczos3
      })
      .grayscale()
      .normalize()
      .sharpen()
      .threshold(190)
      .png()
      .toBuffer();

    const inverted = await crop
      .clone()
      .resize({
        width: targetWidth,
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
      name: region.name + "-contrast",
      buffer: contrast
    });

    images.push({
      name: region.name + "-threshold-130",
      buffer: threshold130
    });

    images.push({
      name: region.name + "-threshold-160",
      buffer: threshold160
    });

    images.push({
      name: region.name + "-threshold-190",
      buffer: threshold190
    });

    images.push({
      name: region.name + "-inverted",
      buffer: inverted
    });
  }

  return images;
}

async function recognizeOcrImage(
  worker,
  image,
  nickname
) {
  const result = await worker.recognize(image.buffer);

  const text = String(result.data.text || "").trim();
  const level = cleanRecognizedLevel(text);
  const confidence = Number(result.data.confidence || 0);

  console.log(
    `${nickname} ${image.name}: ` +
    `"${text}" => ${level || "none"} ` +
    `(confidence ${confidence.toFixed(1)})`
  );

  return {
    level: level,
    confidence: confidence,
    imageName: image.name
  };
}

function chooseBestLevel(results) {
  const validResults = results.filter(function(result) {
    return (
      Number.isInteger(result.level) &&
      result.level >= 1 &&
      result.level <= 999
    );
  });

  if (!validResults.length) {
    return 0;
  }

  const groups = new Map();

  for (const result of validResults) {
    if (!groups.has(result.level)) {
      groups.set(result.level, {
        level: result.level,
        count: 0,
        confidenceTotal: 0,
        highestConfidence: 0
      });
    }

    const group = groups.get(result.level);

    group.count++;
    group.confidenceTotal += result.confidence;
    group.highestConfidence = Math.max(
      group.highestConfidence,
      result.confidence
    );
  }

  const rankedGroups = Array.from(groups.values())
    .sort(function(a, b) {
      if (b.count !== a.count) {
        return b.count - a.count;
      }

      if (
        b.confidenceTotal !== a.confidenceTotal
      ) {
        return (
          b.confidenceTotal -
          a.confidenceTotal
        );
      }

      if (
        b.highestConfidence !==
        a.highestConfidence
      ) {
        return (
          b.highestConfidence -
          a.highestConfidence
        );
      }

      return b.level - a.level;
    });

  const best = rankedGroups[0];

  console.log(
    `Best OCR candidate: ${best.level}, ` +
    `${best.count} matches, ` +
    `best confidence ${best.highestConfidence.toFixed(1)}`
  );

  /*
    Accept the result when multiple image treatments agree,
    or when one result has high confidence.
  */
  if (
    best.count >= 2 ||
    best.highestConfidence >= 80
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
      const result = await recognizeOcrImage(
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
