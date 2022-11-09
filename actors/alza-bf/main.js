import { HttpCrawler } from "@crawlee/http";
import { ActorType } from "@hlidac-shopu/actors-common/actor-type.js";
import { uploadToKeboola } from "@hlidac-shopu/actors-common/keboola.js";
import { cleanPrice } from "@hlidac-shopu/actors-common/product.js";
import Rollbar from "@hlidac-shopu/actors-common/rollbar.js";
import { withPersistedStats } from "@hlidac-shopu/actors-common/stats.js";
import { parseStructuredData } from "@topmonks/eu-shop-monitoring-lib/structured-data-extractor.mjs";
import { Actor, Dataset, KeyValueStore, log } from "apify";
import { parseHTML } from "linkedom/cached";

export const Label = {
  Category: "CATEGORY",
  Detail: "DETAIL",
  Pagination: "PAGINATION"
};

export const extractItem = item => (Array.isArray(item) ? item[0] : item);

function getOffer(jsonld, microdata) {
  const product = extractItem(jsonld.get("Product"));
  const offers = product?.offers ?? microdata.get("offers");
  if (!offers) return new Map();

  const firstOffer = extractItem(offers);
  if (firstOffer instanceof Map) return firstOffer;
  return new Map(Object.entries(firstOffer));
}

/**
 * Extracts prices from structured data
 * @param {Map<string, any>} structuredData
 * @returns {* | null}
 */
export function extractStructuredData(structuredData) {
  const metaTags = structuredData.get("metatags");
  const jsonLd = structuredData.get("jsonld");
  const microdata = structuredData.get("microdata");
  const offer = getOffer(jsonLd, microdata);

  const currentPrice =
    extractItem(metaTags.get("product:price:amount")) ??
    extractItem(offer.get("lowPrice")) ??
    extractItem(offer.get("price"));
  const currency =
    extractItem(metaTags.get("product:price:currency")) ??
    extractItem(offer.get("priceCurrency"));
  const referralPrice =
    extractItem(offer.get("lowPrice")) != extractItem(offer.get("highPrice"))
      ? extractItem(offer.get("highPrice"))
      : null;

  return {
    itemName: extractItem(metaTags.get("twitter:title")),
    itemUrl: extractItem(metaTags.get("og:url")),
    img: extractItem(metaTags.get("twitter:image")),
    category: extractItem(jsonLd.get("BreadcrumbList"))
      .itemListElement.map(x => x.item.name)
      .join(" > "),
    itemCode: extractItem(jsonLd.get("Product"))?.sku,
    rating: extractItem(jsonLd.get("Product"))?.aggregateRating?.ratingValue,
    inStock: offer?.availability === "http://schema.org/InStock",
    discontinued: offer?.availability === "http://schema.org/Discontinued",
    currentPrice: cleanPrice(currentPrice),
    currency,
    originalPrice: cleanPrice(referralPrice)
  };
}

/**
 * @param {String} encodedString
 * @return {String}
 */
function decodeEntities(encodedString) {
  const translate_re = /&(nbsp|amp|quot|lt|gt);/g;
  const translate = new Map([
    ["nbsp", " "],
    ["amp", "&"],
    ["quot", '"'],
    ["lt", "<"],
    ["gt", ">"]
  ]);
  return encodedString
    .replace(translate_re, (match, entity) => translate.get(entity))
    .replace(/&#(\d+);/gi, (match, numStr) =>
      String.fromCharCode(parseInt(numStr, 10))
    );
}

/**
 * @param {Document} document
 */
function extractDOM(document) {
  const detailPage = document.querySelector(".detail-page");
  if (!detailPage) return;
  return {
    itemId: detailPage.dataset.id,
    originalPrice: cleanPrice(
      document.querySelector("#detailText .price-box__compare-price")
        ?.textContent
    )
  };
}

/**
 * @param {Document} document
 * @param {Map} structuredData
 * @return {any}
 */
function extractDetail(document, structuredData) {
  const domParts = extractDOM(document);
  if (!domParts) return;
  const structuredParts = extractStructuredData(structuredData);
  return Object.assign({}, structuredParts, domParts, {
    category: decodeEntities(structuredParts.category)
  });
}

function extractPaginationInfo(document) {
  if (!document.querySelector(".surveyInfoForm")) {
    console.log(document.innerHTML);
    return null;
  }
  const categoryId = cleanPrice(
    document.querySelector(".surveyInfoForm")?.dataset?.id
  );
  const itemsCount = cleanPrice(
    document.getElementById("lblNumberItem")?.textContent
  );
  const pages = Math.ceil(itemsCount / 24);
  return { categoryId, pages };
}

function createPaginationPayload({ categoryId, page }) {
  return JSON.stringify({
    "idCategory": categoryId,
    "producers": "",
    "parameters": [],
    "idPrefix": 0,
    "prefixType": 3,
    "page": page,
    // "pageTo": page,
    "availabilityType": 0,
    "newsOnly": false,
    "commodityStatusType": 1,
    "upperDescriptionStatus": 0,
    "branchId": -2,
    "sort": 0,
    "categoryType": 29,
    "searchTerm": "",
    "sendProducers": false,
    "layout": 1,
    "append": false,
    "yearFrom": null,
    "yearTo": null,
    "artistId": null,
    "minPrice": -1,
    "maxPrice": -1,
    "showOnlyActionCommodities": false,
    "callFromParametrizationDialog": false,
    "commodityWearType": null,
    "configurationId": 3,
    "sectionId": 1,
    "hash": `#f&cst=1&cud=0&pg=${page}&prod=`,
    "counter": page + 1
  });
}

export async function main() {
  const rollbar = Rollbar.init();
  const input = (await KeyValueStore.getInput()) ?? {};

  const {
    country = "CZ",
    maxConcurrency = 10,
    proxyGroups = ["CZECH_LUMINATI"],
    type = ActorType.BlackFriday,
    urls = []
  } = input;

  const requestQueue = await Actor.openRequestQueue();
  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: proxyGroups
  });

  const stats = await withPersistedStats(x => x, {
    categories: 0,
    details: 0,
    duplicates: 0,
    pages: 0,
    items: 0,
    target: 0,
    targetPages: 0,
    denied: 0,
    captchas: 0,
    ok: 0,
    zeroItems: 0,
    errors: 0
  });

  switch (type) {
    case ActorType.BlackFriday: {
      if (urls.length === 0) {
        await requestQueue.addRequest({
          url: `https://www.alza.${country.toLowerCase()}/black-friday`,
          userData: {
            label: Label.Category
          }
        });
      }
      break;
    }
    default:
      if (urls.length === 0) {
        log.info("No URLs provided");
      }
  }

  const crawler = new HttpCrawler({
    requestQueue,
    useSessionPool: true,
    sessionPoolOptions: {
      maxPoolSize: 50,
      persistStateKeyValueStoreId: "alza-sessions"
    },
    proxyConfiguration,
    maxConcurrency,
    async requestHandler({
      request,
      response,
      body,
      json,
      session,
      log,
      enqueueLinks
    }) {
      const { label } = request.userData;

      log.info(`Visiting: ${request.url}, ${label}`);
      if (response.statusCode === 403) {
        stats.inc("denied");
        session.isBlocked();
        throw new Error("Access Denied");
      }
      if (response.statusCode === 200) stats.inc("ok");
      session.setCookiesFromResponse(response);
      const createUrl = s => new URL(s, request.url).href;
      switch (label) {
        case Label.Category: {
          const html = body.toString();
          const { document } = parseHTML(html);
          const pagination = extractPaginationInfo(document);
          if (!pagination) {
            log.info(document.innerHTML);
            session.isBlocked();
            stats.inc("errors");
            throw new Error("Can't find pagination info");
          }
          const { categoryId, pages } = pagination;
          console.log({ categoryId, pages });
          const url = createUrl("/Services/EShopService.svc/Filter");
          for (let page = 0; page < pages; page++) {
            await requestQueue.addRequest({
              url,
              uniqueKey: `${url}?page=${page}`,
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
              },
              payload: createPaginationPayload({ categoryId, page }),
              userData: { label: Label.Pagination }
            });
          }
          stats.inc("categories");
          return;
        }
        case Label.Pagination: {
          try {
            const { d } = json;
            const { document } = parseHTML(d.Boxes);
            const urls = Array.from(
              document.querySelectorAll(".browsinglink.name")
            ).map(x => createUrl(x.href));
            await enqueueLinks({ label: Label.Detail, urls });
            stats.inc("pages");
          } catch (err) {
            stats.inc("errors");
            session.isBlocked();
            throw new Error("Unreadable JSON");
          }
          return;
        }
        case Label.Detail: {
          const html = body.toString();
          const { document } = parseHTML(html);
          const structuredData = parseStructuredData(document);
          const detail = extractDetail(document, structuredData);
          if (!detail) {
            session.isBlocked();
            stats.inc("zeroItems");
            return;
          }
          await Dataset.pushData(detail);
          stats.inc("details");
          return;
        }
      }
    },
    async failedRequestHandler({ request, log }, error) {
      rollbar.error(error, request);
      log.error(`Request ${request.url} ${error.message} failed 4 times`);
    }
  });

  await crawler.addRequests(urls);
  await crawler.run();
  await stats.save();

  try {
    await uploadToKeboola("alza_cz_bf");
  } catch (err) {
    log.error(err);
  }
}

await Actor.main(main, { statusMessage: "DONE" });
