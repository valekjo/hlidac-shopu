import { S3Client } from "@aws-sdk/client-s3";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { uploadToKeboola } from "@hlidac-shopu/actors-common/keboola.js";
import {
  invalidateCDN,
  uploadToS3v2
} from "@hlidac-shopu/actors-common/product.js";
import Apify from "apify";
import rollbar from "@hlidac-shopu/actors-common/rollbar.js";
import { withPersistedStats } from "@hlidac-shopu/actors-common/stats.js";
import { URL } from "url";

const { log } = Apify.utils;

async function handleStart(
  { $, requestQueue, request },
  { homePageUrl, inputData, stats }
) {
  let categoryLinkList = $(
    ".headr__nav-cat-col-inner > .headr__nav-cat-row > a.headr__nav-cat-link"
  )
    .map(function () {
      return {
        href: $(this).attr("href"),
        dataWebtrekk: $(this).attr("data-webtrekk")
      };
    })
    .get();
  if (!(categoryLinkList.length > 0)) {
    categoryLinkList = $("ul.first-level > li > a")
      .map(function () {
        return {
          href: $(this).attr("href")
        };
      })
      .get();
  }
  log.debug(`[handleStart] label: ${request.userData.label}`, {
    url: request.url,
    categoryLinkList
  });
  if (inputData.development) {
    categoryLinkList = categoryLinkList.slice(0, 1);
    log.debug(`development mode, subcategory is`, { categoryLinkList });
  }

  for (const categoryObject of categoryLinkList) {
    if (!categoryObject.dataWebtrekk) {
      const categoryUrl = new URL(categoryObject.href, homePageUrl).href;
      await requestQueue.addRequest({
        url: categoryUrl,
        userData: { label: "SUBCAT" }
      });
      stats.inc("urls");
    }
  }
}

async function handleSubCategory(context, { homePageUrl, inputData, stats }) {
  const { $, requestQueue, request } = context;
  const productCount = parseInt($(".variants").data("productcount"), 10);
  const label = request.userData.label;
  log.debug(`[handleSubCategory] label: ${label}`, {
    url: request.url,
    productCount
  });

  if (productCount) {
    await handleLastSubCategory(context, { inputData, stats });
  } else {
    let subCategoryList = $('a[wt_name="assortment_menu.level2"]')
      .map(function () {
        return $(this).attr("href");
      })
      .toArray();
    log.debug(`${label}`, { subCategoryList });
    if (inputData.development) {
      subCategoryList = subCategoryList.slice(0, 1);
      log.debug(`development mode, ${label} is`, subCategoryList);
    }
    for (const subcategoryLink of subCategoryList) {
      const subcategoryUrl = new URL(subcategoryLink, homePageUrl).href;
      await requestQueue.addRequest({
        url: subcategoryUrl,
        userData: { label }
      });
      stats.inc("urls");
    }
  }
}

async function handleLastSubCategory(context, { inputData, stats }) {
  const { $, requestQueue, request } = context;
  const productCount = parseInt($(".variants").data("productcount"), 10);
  log.debug(`[handleLastSubCategory] label: ${request.userData.label}`, {
    url: request.url,
    productCount
  });
  const productPerPageCount = $("li.product > a")
    .map(function () {
      if ($(this).attr("data-ui-name")) {
        return $(this).attr("href");
      }
    })
    .get().length;
  let pageCount = Math.ceil(productCount / productPerPageCount);
  if (inputData.development) {
    pageCount = 1;
  }
  if (pageCount > 1) {
    const requestList = Array(pageCount - 1)
      .fill(0)
      .map((_, i) => i + 2)
      .map(i => {
        const url = `${request.url}/?page=${i}`;
        return requestQueue.addRequest({
          url,
          userData: { label: "LIST" }
        });
      });
    await Promise.all(requestList);
    stats.add("urls", requestList.length);
  }
  await handleList(context, { stats });
}

async function handleList({ $, requestQueue, request }, { stats }) {
  let productLinkList = $("li.product > a")
    .map(function () {
      if ($(this).attr("data-ui-name")) {
        return $(this).attr("href");
      }
    })
    .toArray();
  log.debug(`[handleList] label: ${request.userData.label}`, {
    url: request.url,
    productLinkList
  });
  const requestList = productLinkList.map(url =>
    requestQueue.addRequest({
      url: new URL(url, request.url).href,
      userData: { label: "DETAIL" }
    })
  );
  await Promise.all(requestList);
  stats.add("urls", requestList.length);
}

async function handleDetail(
  context,
  { dataset, s3, processedIds, pushList, variantIds, stats }
) {
  const { request, $ } = context;
  const itemName = $(".overview__description >.overview__heading")
    .text()
    .trim();
  const itemId = $('input[name="code"]').attr("value").trim();
  let currency = $('meta[itemprop="priceCurrency"]')
    .map(function () {
      return $(this).attr("content");
    })
    .get()[0];
  if (currency === "SKK") {
    currency = "EUR";
  }
  let currentPrice = $('[data-ui-name="ads.price.strong"]').text();
  currentPrice = parsePrice(currentPrice);
  let discountedPrice = $(".saving").get(0);
  let originalPrice = null;
  if (discountedPrice) {
    originalPrice = $(discountedPrice.parent.children)
      .map(function () {
        const el = $(this);
        const tagName = el.get(0).tagName;
        if (tagName === "del") {
          const text = el.text();
          if (text.match(/\d/)) {
            return text;
          }
        }
      })
      .get(0);
    originalPrice = parsePrice(originalPrice);
    discountedPrice = originalPrice - currentPrice;
  }
  const discounted = Boolean(discountedPrice);
  const inStock = Boolean($("div.marg_b5").text().match(/(\d+)/));
  let img = $(".ads-slider__link").attr("href");
  if (!img) {
    img = $(".ads-slider__image")
      .map(function () {
        return $(this).data("src");
      })
      .get(0);
  }
  img = `https:${img}`;
  const category = $('a[class*="normal"][wt_name*="breadcrumb.level"]')
    .map(function () {
      return $(this).text();
    })
    .toArray()
    .join("/");
  const result = {
    itemUrl: request.url,
    itemName,
    itemId,
    currency,
    currentPrice,
    discounted,
    originalPrice,
    inStock,
    img,
    category
  };
  if (!processedIds.has(result.itemId)) {
    pushList.push(
      // push data to dataset to be ready for upload to Keboola
      dataset.pushData(result),
      // upload JSON+LD data to CDN
      uploadToS3v2(s3, result)
    );
    processedIds.add(result.itemId);
    stats.inc("items");
  } else {
    stats.inc("itemsDuplicity");
  }
  stats.inc("totalItems");
  if (pushList.length > 70) {
    await Promise.all(pushList);
    pushList = [];
  }

  await handleVariant(context, { variantIds, processedIds, stats });
}

function getItemIdFromUrl(url) {
  return url.match(/p\/(\d+)(#\/)?$/)?.[1];
}

async function handleVariant(
  { $, requestQueue, request },
  { variantIds, processedIds, stats }
) {
  let crawledItemId = getItemIdFromUrl(request.url);
  let productLinkList = $(
    `.selectboxes .selectbox li:not([class*="disabled"]) a[wt_name*="size_variant"],
    .selectboxes .selectbox li[data-ui-name="ads.variants.color.enabled"] a[wt_name*="color_variant"]`
  )
    .map(function () {
      let productUrl = $(this).attr("href");
      if (!productUrl) {
        return;
      }
      let itemId = getItemIdFromUrl(productUrl);
      if (
        crawledItemId === itemId ||
        variantIds.has(itemId) ||
        processedIds.has(itemId)
      ) {
        return;
      }
      variantIds.add(itemId);
      return productUrl;
    })
    .toArray();

  if (!productLinkList.length) return;

  log.debug(`[handleVariant] label: ${request.userData.label}`, {
    url: request.url,
    productLinkList
  });

  const requestList = productLinkList.map(url => {
    return requestQueue.addRequest({
      url: url,
      userData: { label: "DETAIL" }
    });
  });
  await Promise.all(requestList);
  stats.add("urls", requestList.length);
}

function parsePrice(text) {
  let price = text
    .trim()
    .replace(/\s|'/g, "")
    .replace(/,/, ".")
    .match(/(\d+(.\d+)?)/)[0];
  price = parseFloat(price);
  return price;
}

Apify.main(async function main() {
  log.info("Actor starts.");

  rollbar.init();

  const s3 = new S3Client({ region: "eu-central-1", maxAttempts: 3 });
  const cloudfront = new CloudFrontClient({
    region: "eu-central-1",
    maxAttempts: 3
  });

  const processedIds = new Set();
  const variantIds = new Set();
  let stats = await withPersistedStats(x => x, {
    urls: 0,
    items: 0,
    itemsDuplicity: 0,
    totalItems: 0
  });
  let pushList = [];

  const input = await Apify.getInput();

  const {
    development = false,
    debug = false,
    proxyGroups = ["CZECH_LUMINATI"],
    maxRequestRetries = 3,
    maxConcurrency = 10
  } = input ?? {};
  const country = input?.country?.toLowerCase() ?? "cz";
  const inputData = { country, development, debug };

  if (development || debug) {
    log.setLevel(Apify.utils.log.LEVELS.DEBUG);
  }

  const dataset = await Apify.openDataset();

  const requestQueue = await Apify.openRequestQueue();
  let homePageUrl = `https://www.obi${
    country === "it" ? "-italia" : ""
  }.${country}`;
  await requestQueue.addRequest({
    url: homePageUrl,
    userData: { label: "START" }
  });

  const proxyConfiguration = await Apify.createProxyConfiguration({
    groups: proxyGroups,
    useApifyProxy: !development
  });

  const crawler = new Apify.CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency,
    maxRequestRetries,
    async handlePageFunction(context) {
      const { label } = context.request.userData;
      context.requestQueue = requestQueue;
      if (label === "START") {
        await handleStart(context, { homePageUrl, inputData, stats });
      } else if (label === "SUBCAT") {
        await handleSubCategory(context, { homePageUrl, inputData, stats });
      } else if (label === "LIST") {
        await handleList(context, { stats });
      } else if (label === "DETAIL") {
        await handleDetail(context, {
          dataset,
          s3,
          processedIds,
          pushList,
          variantIds,
          stats
        });
      }
    },
    async handleFailedRequestFunction({ request }) {
      log.error(`Request ${request.url} failed multiple times`, request);
    }
  });

  log.info("crawler starts.");
  await crawler.run();
  log.info("crawler finished");

  await stats.save();

  const directoryName = `obi${country === "it" ? "-italia" : ""}.${country}`;
  await invalidateCDN(cloudfront, "EQYSHWUECAQC9", directoryName);
  log.info(`invalidated Data CDN ${directoryName}`);

  if (!development) {
    const tableName = `obi${country === "it" ? "-italia" : ""}_${country}`;
    await uploadToKeboola(tableName);
    log.info(`update to Keboola finished ${tableName}.`);
  }
  log.info("Actor Finished.");
});
