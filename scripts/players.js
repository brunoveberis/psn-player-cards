const fs = require("fs");
const sharp = require("sharp");
const { createWorker, PSM } = require("tesseract.js");

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
      "User-Agent": "Mozilla/5.0 GitHubAction PSN Player Cards"
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error(
      `Card generator returned HTTP ${response.status}`
    );
  }

  const text = await response.text();

  return extractCardUrl(text);
}

async function tryGetCardFromProfilePage(nickname) {
  const response = await fetch(getProfileUrl(nickname), {
    headers: {
      "User-Agent": "Mozilla/5.0 GitHubAction PSN Player Cards"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Profile page returned HTTP ${response.status}`
    );
  }

  const text = await response.text();

  return extractCardUrl(text);
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

  const fallback = getFallbackCardUrl(nickname);

  console.log(
    `Using fallback card URL for ${nickname}: ${fallback}`
  );

  return fallback;
}

async function downloadImage(imageUrl) {
  const response = await fetch(
    imageUrl + (imageUrl.includes("?") ? "&" : "?") + "cache=" + Date.now(),
    {
      headers: {
        "User-Agent": "Mozilla/5.0 GitHubAction PSN Player Cards",
        "Accept": "image/png,image/*;q=0.8,*/*;q=0.5"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Card image returned HTTP ${response.status}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.includes("image")) {
    throw new Error(
      `Card response was not an image: ${contentType}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

function cleanOcrNumber(text) {
  const cleaned = String(text || "")
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/[Bb]/g, "8")
    .replace(/[^0-9]/g, "");

  if (!cleaned) {
    return 0;
  }

  const number = Number.parseInt(cleaned, 10);

  if (
    !Number.isInteger(number) ||
    number < 1 ||
    number > 999
  ) {
    return 0;
  }

  return number;
}

async function makeLevelImages(cardBuffer) {
  const metadata = await sharp(cardBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not determine card dimensions");
  }

  /*
    The PSN trophy level is located inside the large circle
    near the upper-left corner of the Exophase card.

    The crop uses percentages so it works with cards rendered
    at different resolutions.
  */
  const left = Math.max(
    0,
    Math.round(metadata.width * 0.045)
  );

  const top = Math.max(
    0,
    Math.round(metadata.height * 0.095)
  );

  const width = Math.min(
    metadata.width - left,
    Math.max(40, Math.round(metadata.width * 0.14))
  );

  const height = Math.min(
    metadata.height - top,
    Math.max(30, Math.round(metadata.height * 0.23))
  );

  const crop = sharp(cardBuffer).extract({
    left: left,
    top: top,
    width: width,
    height: height
  });

  const normal = await crop
    .clone()
    .resize({
      width: width * 10,
      height: height * 10,
      fit: "fill",
      kernel: sharp.kernel.lanczos3
    })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();

  const threshold120 = await crop
    .clone()
    .resize({
      width: width * 10,
      height: height * 10,
      fit: "fill",
      kernel: sharp.kernel.lanczos3
    })
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(120)
    .png()
    .toBuffer();

  const threshold150 = await crop
    .clone()
    .resize({
      width: width * 10,
      height: height * 10,
      fit: "fill",
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
      width: width * 10,
      height: height * 10,
      fit: "fill",
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
      width: width * 10,
      height: height * 10,
      fit: "fill",
      kernel: sharp.kernel.lanczos3
    })
    .grayscale()
    .normalize()
    .negate()
    .sharpen()
    .threshold(150)
    .png()
    .toBuffer();

  return [
    normal,
    threshold120,
    threshold150,
    threshold180,
    inverted
  ];
}

async function readPsnLevel(cardBuffer, worker, nickname) {
  const levelImages = await makeLevelImages(cardBuffer);
  const candidates = [];

  for (let index = 0; index < levelImages.length; index++) {
    try {
      const result = await worker.recognize(levelImages[index]);
      const text = result.data.text || "";
      const level = cleanOcrNumber(text);
      const confidence = Number(result.data.confidence || 0);

      console.log(
        `OCR attempt ${index + 1} for ${nickname}: ` +
        `"${text.trim()}" => ${level || "not found"} ` +
        `(confidence ${confidence.toFixed(1)})`
      );

      if (level > 0) {
        candidates.push({
          level: level,
          confidence: confidence
        });
      }
    } catch (error) {
      console.log(
        `OCR attempt ${index + 1} failed for ${nickname}: ` +
        error.message
      );
    }
  }

  if (!candidates.length) {
    return 0;
  }

  /*
    Prefer a number detected by multiple preprocessing attempts.
    When frequencies are equal, use the highest OCR confidence.
  */
  const grouped = new Map();

  for (const candidate of candidates) {
    if (!grouped.has(candidate.level)) {
      grouped.set(candidate.level, {
        level: candidate.level,
        count: 0,
        bestConfidence: 0
      });
    }

    const item = grouped.get(candidate.level);

    item.count++;
    item.bestConfidence = Math.max(
      item.bestConfidence,
      candidate.confidence
    );
  }

  const rankedCandidates = Array.from(grouped.values())
    .sort(function(a, b) {
      if (b.count !== a.count) {
        return b.count - a.count;
      }

      return b.bestConfidence - a.bestConfidence;
    });

  return rankedCandidates[0].level;
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

async function main() {
  console.log("Loading player names from Google Sheets...");

  const response = await fetch(csvUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 GitHubAction PSN Player Cards"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Google Sheet: HTTP ${response.status}`
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

  console.log(`Found ${names.length} unique players.`);

  const worker = await createWorker("eng");

  await worker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: PSM.SINGLE_WORD,
    preserve_interword_spaces: "0"
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
          `Could not read card for ${nickname}: ${error.message}`
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
          `Detected PSN level for ${nickname}: ${psnLevel}`
        );
      } else {
        console.log(
          `PSN level could not be detected for ${nickname}`
        );
      }

      await sleep(1000);
    }
  } finally {
    await worker.terminate();
  }

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
