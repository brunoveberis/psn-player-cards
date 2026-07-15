const fs = require("fs");

const PLAYERS_FILE = "players.json";
const MAX_ATTEMPTS = 3;
const REQUEST_DELAY_MS = 800;

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36",

  Accept: "image/avif,image/webp,image/apng,image/png,image/*,*/*;q=0.8",

  "Accept-Language": "en-US,en;q=0.9",

  "Cache-Control": "no-cache",

  Pragma: "no-cache"
};

function sleep(milliseconds) {
  return new Promise(function(resolve) {
    setTimeout(resolve, milliseconds);
  });
}

function getBaseCardUrl(player) {
  if (player.cardUrl) {
    try {
      const url = new URL(String(player.cardUrl));

      /*
        Noņem iepriekš pievienotos keša parametrus,
        lai tie nekrātos pēc katras GitHub Action izpildes.
      */
      url.searchParams.delete("ts");
      url.searchParams.delete("cache");

      return url.toString();
    } catch (error) {
      console.log(
        `${player.name}: invalid cardUrl, using fallback`
      );
    }
  }

  return (
    "https://card.exophase.com/psn/" +
    encodeURIComponent(player.name) +
    ".png"
  );
}

function createTimestampedUrl(baseUrl, timestamp, attempt) {
  const url = new URL(baseUrl);

  url.searchParams.set(
    "ts",
    timestamp + "-" + attempt
  );

  return url.toString();
}

async function checkCardUrl(cardUrl, playerName) {
  const controller = new AbortController();

  const timeout = setTimeout(function() {
    controller.abort();
  }, 30000);

  try {
    const response = await fetch(cardUrl, {
      method: "GET",
      headers: REQUEST_HEADERS,
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (
      !contentType
        .toLowerCase()
        .startsWith("image/")
    ) {
      throw new Error(
        `response is not an image: ${contentType}`
      );
    }

    /*
      Izlasām atbildes saturu, lai pieprasījums tiešām
      pabeigtu attēla lejupielādi, nevis pārbaudītu tikai headerus.
    */
    const imageBuffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (imageBuffer.length < 1000) {
      throw new Error(
        `image is unexpectedly small: ${imageBuffer.length} bytes`
      );
    }

    console.log(
      `${playerName}: card loaded successfully, ` +
      `${imageBuffer.length} bytes`
    );

    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function getWorkingTimestampedUrl(player, timestamp) {
  const baseUrl = getBaseCardUrl(player);

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {
    const timestampedUrl =
      createTimestampedUrl(
        baseUrl,
        timestamp,
        attempt
      );

    try {
      console.log(
        `${player.name}: checking ${timestampedUrl}`
      );

      const works = await checkCardUrl(
        timestampedUrl,
        player.name
      );

      if (works) {
        return timestampedUrl;
      }
    } catch (error) {
      console.log(
        `${player.name}: attempt ${attempt} failed: ` +
        error.message
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(attempt * 1500);
    }
  }

  /*
    Ja svaigais pieprasījums neizdodas, neatstājam
    bojātu timestamp URL. Saglabājam pamata adresi.
  */
  console.log(
    `${player.name}: card could not be verified, ` +
    "keeping base URL"
  );

  return baseUrl;
}

function loadPlayers() {
  if (!fs.existsSync(PLAYERS_FILE)) {
    throw new Error(
      `${PLAYERS_FILE} does not exist`
    );
  }

  const contents = fs.readFileSync(
    PLAYERS_FILE,
    "utf8"
  );

  const players = JSON.parse(contents);

  if (!Array.isArray(players)) {
    throw new Error(
      `${PLAYERS_FILE} does not contain an array`
    );
  }

  return players;
}

function savePlayers(players) {
  const temporaryFile =
    PLAYERS_FILE + ".tmp";

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(players, null, 2),
    "utf8"
  );

  fs.renameSync(
    temporaryFile,
    PLAYERS_FILE
  );
}

async function main() {
  const players = loadPlayers();

  console.log(
    `Refreshing card URLs for ${players.length} players...`
  );

  /*
    Viens kopīgs timestamp vienai GitHub Action izpildei.
    Nākamajā izpildē tas mainīsies un pārlūks prasīs
    svaigu kartītes versiju.
  */
  const timestamp = Date.now();

  for (
    let index = 0;
    index < players.length;
    index++
  ) {
    const player = players[index];

    if (!player || !player.name) {
      continue;
    }

    console.log("");
    console.log(
      `Processing ${index + 1}/${players.length}: ` +
      player.name
    );

    player.cardUrl =
      await getWorkingTimestampedUrl(
        player,
        timestamp
      );

    /*
      Saglabājam arī laiku diagnostikai.
      Mājaslapā šis lauks nav jāattēlo.
    */
    player.cardCheckedAt =
      new Date(timestamp).toISOString();

    await sleep(REQUEST_DELAY_MS);
  }

  savePlayers(players);

  console.log("");
  console.log(
    `Updated ${PLAYERS_FILE} with refreshed card URLs.`
  );
}

main().catch(function(error) {
  console.error("");
  console.error("Card URL refresh failed:");
  console.error(error);
  process.exit(1);
});
