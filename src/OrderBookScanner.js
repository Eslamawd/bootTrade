class OrderBookScanner {
  constructor(dbManager) {
    this.db = dbManager;
    this.orderBooks = {};
  }

  analyzeWhales(symbol, orderBook, indicators) {
    const avgVolume = indicators.avgVolume;
    if (!orderBook || !orderBook.bids)
      return { score: 0, reasons: [], warnings: [], whales: [] };

    if (!this.volumeHistory) this.volumeHistory = {};

    this.volumeHistory[symbol] = { avgVolume };

    const dynamicThreshold = Math.min(
      Math.max(indicators.close * avgVolume * 0.001, 20000),
      indicators.close * avgVolume * 0.02
    );

    let score = 0;
    const reasons = [];
    const warnings = [];
    const whales = [];

    for (let i = 0; i < Math.min(20, orderBook.bids.length); i++) {
      const value = orderBook.bids[i][0] * orderBook.bids[i][1];
      if (value >= dynamicThreshold) {
        whales.push({
          value,
          position: i + 1,
          size: (value / 1000).toFixed(1) + "K",
        });
      }
    }

    if (whales.length >= 10) {
      score += 20;
      reasons.push(`🐋🐋🐋 ${whales.length} حيتان نشطة`);
    } else if (whales.length > 0) {
      score += 2.5 * whales.length;
      reasons.push(`🐋 رصد ${whales.length} حوت`);
    }

    // هؤلاء هم الحيتان الذين سيتنفذ أمرهم فوراً إذا نزل السعر قليلاً
    const frontLineWhales = whales.filter((w) => w.position <= 3).length;
    if (frontLineWhales >= 1) {
      score += 5;
      reasons.push("🛡️ حوت هجومي في الخط الأول (دعم مباشر)");
    }
    this.dbManager
      .saveWhaleSighting(symbol, {
        count: whales.length,
        largestValue: whales.length
          ? Math.max(...whales.map((w) => w.value))
          : 0,
        avgValue: whales.length
          ? whales.reduce((a, b) => a + b.value, 0) / whales.length
          : 0,
        positions: whales.map((w) => w.position),
        powerScore: score,
      })
      .catch(() => {});

    return { score, reasons, warnings, whales, dynamicThreshold };
  }

  analyzeOrderBookDynamics(symbol, orderBook) {
    if (!orderBook?.bids || !orderBook?.asks || orderBook.bids.length < 15) {
      return { score: 0, imbalance: 0, reasons: [], strongWall: null };
    }

    // 1. حساب الاختلال (Imbalance) بدقة
    const bidVolume = orderBook.bids
      .slice(0, 15)
      .reduce((s, b) => s + b[0] * b[1], 0);
    const askVolume = orderBook.asks
      .slice(0, 15)
      .reduce((s, a) => s + a[0] * a[1], 0);
    const imbalance = askVolume > 0 ? bidVolume / askVolume : 0;

    let score = 0;
    const reasons = [];

    if (imbalance > 2.5 && imbalance <= 8) {
      score += 20;
      reasons.push(`🌊 سيولة شراء (Imbalance: ${imbalance.toFixed(1)}x)`);
    } else if (imbalance > 8) {
      score += 5;
    }

    // 2. تحديد عتبة الجدار الديناميكية
    let wallThreshold = 100000;
    if (symbol.includes("BTC")) wallThreshold = 1500000;
    else if (symbol.includes("ETH")) wallThreshold = 700000;
    else if (symbol.includes("SOL")) wallThreshold = 250000;

    // 3. تحليل "تكتل السيولة" (Liquidity Cluster Analysis)
    // بدلاً من البحث عن أكبر جدار، سنبحث عن المنطقة التي يتركز فيها المال
    let bestCluster = { price: 0, volume: 0, count: 0 };

    // نمر على أول 10 مستويات فقط (المنطقة الأكثر تأثيراً)
    for (let i = 0; i < 10; i++) {
      const price = orderBook.bids[i][0];
      const volume = price * orderBook.bids[i][1];

      // إذا وجدنا جداراً قوياً، نبحث عن السيولة المحيطة به في نطاق 0.1%
      if (volume > wallThreshold * 0.7) {
        let clusterVol = 0;
        let clusterCount = 0;

        orderBook.bids.slice(0, 15).forEach((b) => {
          if (Math.abs(b[0] - price) / price < 0.001) {
            // نطاق 0.1%
            clusterVol += b[0] * b[1];
            clusterCount++;
          }
        });

        if (clusterVol > bestCluster.volume) {
          bestCluster = { price, volume: clusterVol, count: clusterCount };
        }
      }
    }

    // 4. تقييم التكتل
    if (bestCluster.volume > wallThreshold) {
      score += 20;
      const formattedVol = (bestCluster.volume / 1000).toFixed(0) + "K";
      reasons.push(
        `🧱 تكتل سيولة (${bestCluster.count} جدران) بقوة $${formattedVol}`
      );
    }

    return {
      score,
      imbalance,
      reasons,
      strongWall: bestCluster.volume > 0 ? bestCluster : null,
    };
  }
}
module.exports = OrderBookScanner;
