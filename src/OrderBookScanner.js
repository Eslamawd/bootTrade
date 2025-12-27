class OrderBookScanner {
  constructor(dbManager) {
    this.db = dbManager;
    this.orderBooks = {};
  }

  // نضع هنا دالة analyzeWhales ودالة analyzeOrderBookDynamics التي أرفقتها أنت
  analyzeWhales(symbol, orderBook, avgVolume = 0) {
    if (!orderBook || !orderBook.bids)
      return { score: 0, reasons: [], warnings: [], whales: [] };

    if (!this.volumeHistory) this.volumeHistory = {};

    this.volumeHistory[symbol] = { avgVolume };

    const dynamicThreshold =
      avgVolume > 0 ? Math.max(20000, avgVolume * 0.005) : 50000;

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

    if (whales.length >= 3) {
      score += 25;
      reasons.push(`🐋🐋🐋 ${whales.length} حيتان نشطة`);
    } else if (whales.length > 0) {
      score += 15;
      reasons.push(`🐋 رصد ${whales.length} حوت`);
    }

    if (whales.filter((w) => w.position <= 5).length >= 2) {
      score += 15;
      reasons.push("🛡️ جدار دعم قوي قريب");
    }

    this.db
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
    if (
      !orderBook ||
      !orderBook.bids ||
      !orderBook.asks ||
      orderBook.bids.length < 15
    )
      return { score: 0, imbalance: 0, reasons: [], strongWall: null };

    // 1. حساب السيولة (Imbalance) - عمق 15 لزيادة الدقة في العملات الكبيرة
    const bidVolume = orderBook.bids
      .slice(0, 15)
      .reduce((sum, b) => sum + b[0] * b[1], 0);
    const askVolume = orderBook.asks
      .slice(0, 15)
      .reduce((sum, a) => sum + a[0] * a[1], 0);
    const imbalance = askVolume > 0 ? bidVolume / askVolume : 0;

    let score = 0;
    const reasons = [];

    // 2. تقييم الاختلال (Imbalance Score)
    if (imbalance > 1.8) {
      score += 30;
      reasons.push(`🌊 سيولة شراء (Imbalance: ${imbalance.toFixed(1)}x)`);
    } else if (imbalance < 0.4) {
      score -= 50; // عقوبة قوية لمنع الدخول أو الاستمرار في صفقة مهددة
    }

    // 3. تحديد عتبة الجدار بناءً على العملة (Dynamic Threshold)
    let wallThreshold = 100000;
    if (symbol.startsWith("BTC")) wallThreshold = 1500000;
    if (symbol.startsWith("ETH")) wallThreshold = 700000;
    if (symbol.startsWith("SOL")) wallThreshold = 250000;
    if (symbol.startsWith("BNB")) wallThreshold = 200000;

    // 4. رصد أقوى جدار دعم وتخزين بياناته (سعر وحجم)
    let strongWall = null;
    let maxWallValue = 0;

    orderBook.bids.slice(0, 15).forEach((bid) => {
      const wallValue = bid[0] * bid[1];
      if (wallValue > wallThreshold && wallValue > maxWallValue) {
        maxWallValue = wallValue;
        strongWall = {
          price: bid[0],
          volume: wallValue,
          formatted: (wallValue / 1000).toFixed(0) + "K",
        };
      }
    });

    if (strongWall) {
      score += 20;
      reasons.push(
        `🧱 جدار دعم صلب ($${strongWall.formatted}) عند ${strongWall.price}`
      );
    }

    return { score, imbalance, reasons, strongWall };
  }

  processWSData(symbol, data) {
    this.orderBooks[symbol] = data;
  }
}
module.exports = OrderBookScanner;
