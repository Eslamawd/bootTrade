const ccxt = require("ccxt");
const WebSocket = require("ws");
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const TI = require("technicalindicators");
const DatabaseManager = require("./DatabaseManagers");
require("dotenv").config();

class analyzeCandle {
  constructor(parameters) {
    this.marketData = parameters.marketData;
    this.config = parameters.config || {
      rsiBuyThreshold: 40,
      rsiSellThreshold: 60,
      minCandles: 5,
      patternConfidence: {
        hammer: 15,
        bullishEngulfing: 20,
        morningStar: 25,
        shootingStar: 15,
        bearishEngulfing: 20,
        eveningStar: 25,
        doji: 10,
        pinBar: 15,
        harami: 18,
      },
    };
  }

  calculateCandleMetrics(candle) {
    if (!candle || candle.length < 5) return null;

    const open = candle[1];
    const high = candle[2];
    const low = candle[3];
    const close = candle[4];

    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const totalRange = high - low;

    return {
      open,
      high,
      low,
      close,
      body,
      upperWick,
      lowerWick,
      totalRange,
      bodyRatio: totalRange > 0 ? body / totalRange : 0,
      upperWickRatio: totalRange > 0 ? upperWick / totalRange : 0,
      lowerWickRatio: totalRange > 0 ? lowerWick / totalRange : 0,
      isBullish: close > open,
      isBearish: close < open,
    };
  }

  analyzeCandleStrength(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return null;

    let strength = 0;
    let type = "NORMAL";

    if (metrics.bodyRatio > 0.7) {
      strength = metrics.isBullish ? 25 : -25;
      type = metrics.isBullish ? "STRONG_BULLISH" : "STRONG_BEARISH";
    } else if (metrics.bodyRatio > 0.3) {
      strength = metrics.isBullish ? 10 : -10;
      type = metrics.isBullish ? "BULLISH" : "BEARISH";
    } else if (metrics.bodyRatio < 0.1) {
      strength = 0;
      type = "DOJI";
    }

    return { strength, type, metrics };
  }

  isHammerCandle(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isSmallBody = metrics.bodyRatio < 0.3;
    const isLongLowerWick = metrics.lowerWick > metrics.body * 2;
    const isShortUpperWick = metrics.upperWick < metrics.body * 0.5;
    const isNearLow = metrics.lowerWickRatio > 0.6;

    return isSmallBody && isLongLowerWick && isShortUpperWick && isNearLow;
  }

  isBullishEngulfing(prevCandle, currentCandle) {
    const prev = this.calculateCandleMetrics(prevCandle);
    const curr = this.calculateCandleMetrics(currentCandle);
    if (!prev || !curr) return false;

    const isPrevBearish = prev.isBearish;
    const isCurrentBullish = curr.isBullish;
    const isEngulfing = curr.open < prev.close && curr.close > prev.open;
    const isStronger = curr.body > prev.body;

    return isPrevBearish && isCurrentBullish && isEngulfing && isStronger;
  }

  isMorningStar(firstCandle, secondCandle, thirdCandle) {
    const first = this.calculateCandleMetrics(firstCandle);
    const second = this.calculateCandleMetrics(secondCandle);
    const third = this.calculateCandleMetrics(thirdCandle);
    if (!first || !second || !third) return false;

    const isFirstLongBearish = first.isBearish && first.bodyRatio > 0.6;
    const isSecondSmall = second.bodyRatio < 0.3;
    const isGapDown = second.high < first.close;
    const isThirdBullish = third.isBullish;
    const firstMid = (first.open + first.close) / 2;
    const closesAboveFirstMid = third.close > firstMid;

    return (
      isFirstLongBearish &&
      isSecondSmall &&
      isGapDown &&
      isThirdBullish &&
      closesAboveFirstMid
    );
  }

  isDojiCandle(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isDoji = metrics.bodyRatio < 0.1;
    const isLongDoji = isDoji && metrics.totalRange > 0.02 * metrics.close;

    return {
      isDoji,
      isLongDoji,
      metrics,
    };
  }

  isShootingStar(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isSmallBody = metrics.bodyRatio < 0.3;
    const isLongUpperWick = metrics.upperWick > metrics.body * 2;
    const isShortLowerWick = metrics.lowerWick < metrics.body * 0.5;
    const isNearHigh = metrics.upperWickRatio > 0.6;
    const hasUpperShadow = metrics.upperWick > 0;

    return (
      isSmallBody &&
      isLongUpperWick &&
      isShortLowerWick &&
      isNearHigh &&
      hasUpperShadow
    );
  }

  isBearishEngulfing(prevCandle, currentCandle) {
    const prev = this.calculateCandleMetrics(prevCandle);
    const curr = this.calculateCandleMetrics(currentCandle);
    if (!prev || !curr) return false;

    const isPrevBullish = prev.isBullish;
    const isCurrentBearish = curr.isBearish;
    const isEngulfing = curr.open > prev.close && curr.close < prev.open;
    const isStronger = curr.body > prev.body;

    return isPrevBullish && isCurrentBearish && isEngulfing && isStronger;
  }

  isEveningStar(firstCandle, secondCandle, thirdCandle) {
    const first = this.calculateCandleMetrics(firstCandle);
    const second = this.calculateCandleMetrics(secondCandle);
    const third = this.calculateCandleMetrics(thirdCandle);
    if (!first || !second || !third) return false;

    const isFirstLongBullish = first.isBullish && first.bodyRatio > 0.6;
    const isSecondSmall = second.bodyRatio < 0.3;
    const isGapUp = second.low > first.high;
    const isThirdBearish = third.isBearish;
    const firstMid = (first.open + first.close) / 2;
    const closesBelowFirstMid = third.close < firstMid;

    return (
      isFirstLongBullish &&
      isSecondSmall &&
      isGapUp &&
      isThirdBearish &&
      closesBelowFirstMid
    );
  }

  isPinBar(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isSmallBody = metrics.bodyRatio < 0.3;
    const hasLongWick =
      Math.max(metrics.upperWick, metrics.lowerWick) > metrics.body * 3;
    const isOneSided =
      Math.min(metrics.upperWick, metrics.lowerWick) < metrics.body * 0.3;

    if (isSmallBody && hasLongWick && isOneSided) {
      return {
        isPinBar: true,
        isBullishPin: metrics.lowerWick > metrics.upperWick * 2,
        isBearishPin: metrics.upperWick > metrics.lowerWick * 2,
        direction:
          metrics.lowerWick > metrics.upperWick ? "BULLISH" : "BEARISH",
      };
    }

    return { isPinBar: false };
  }

  isHarami(prevCandle, currentCandle) {
    const prev = this.calculateCandleMetrics(prevCandle);
    const curr = this.calculateCandleMetrics(currentCandle);
    if (!prev || !curr) return false;

    const isInsideBody = curr.open > prev.close && curr.close < prev.open;
    const isSmallerBody = curr.body < prev.body * 0.5;

    if (isInsideBody && isSmallerBody) {
      return {
        isHarami: true,
        isBullishHarami: prev.isBearish && curr.isBullish,
        isBearishHarami: prev.isBullish && curr.isBearish,
        direction: prev.isBearish ? "BULLISH" : "BEARISH",
      };
    }

    return { isHarami: false };
  }

  isInvertedHammer(candle) {
    const metrics = this.calculateCandleMetrics(candle);
    if (!metrics) return false;

    const isSmallBody = metrics.bodyRatio < 0.3;
    const isLongUpperWick = metrics.upperWick > metrics.body * 2;
    const isShortLowerWick = metrics.lowerWick < metrics.body * 0.5;
    const hasLowerClose = metrics.close < metrics.open * 0.995;

    return isSmallBody && isLongUpperWick && isShortLowerWick && hasLowerClose;
  }

  async analyzeCandlestickPatterns(symbol, indicators = {}) {
    const candles = this.marketData[symbol]?.candles;
    if (!candles || candles.length < this.config.minCandles) {
      return {
        buyPatterns: [],
        sellPatterns: [],
        buyScore: 0,
        sellScore: 0,
        candleStrength: 0,
        recommendation: "NEUTRAL",
      };
    }

    const completedCandles = candles.slice(-4, -1);
    if (completedCandles.length < 3) {
      return {
        buyPatterns: [],
        sellPatterns: [],
        buyScore: 0,
        sellScore: 0,
        candleStrength: 0,
        recommendation: "NEUTRAL",
      };
    }

    const first = completedCandles[0];
    const second = completedCandles[1];
    const third = completedCandles[2];

    const buyPatterns = [];
    const sellPatterns = [];
    let buyScore = 0;
    let sellScore = 0;
    let candleStrength = 0;

    if (this.isHammerCandle(third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi < this.config.rsiBuyThreshold;
      if (rsiCondition) {
        buyPatterns.push(
          `المطرقة (RSI: ${indicators.rsi?.toFixed(1) || "N/A"})`,
        );
        buyScore += this.config.patternConfidence.hammer;
      }
    }

    if (this.isBullishEngulfing(second, third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi < this.config.rsiBuyThreshold + 5;
      if (rsiCondition) {
        buyPatterns.push("الابتلاع الصاعد");
        buyScore += this.config.patternConfidence.bullishEngulfing;
      }
    }

    if (this.isMorningStar(first, second, third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi < this.config.rsiBuyThreshold;
      if (rsiCondition) {
        buyPatterns.push("نجمة الصباح");
        buyScore += this.config.patternConfidence.morningStar;
      }
    }

    const dojiAnalysis = this.isDojiCandle(third);
    if (dojiAnalysis.isDoji && (!indicators.rsi || indicators.rsi < 30)) {
      buyPatterns.push(
        `دوجي في القاع (RSI: ${indicators.rsi?.toFixed(1) || "N/A"})`,
      );
      buyScore += this.config.patternConfidence.doji;
    }

    const pinBarAnalysis = this.isPinBar(third);
    if (pinBarAnalysis.isPinBar && pinBarAnalysis.direction === "BULLISH") {
      buyPatterns.push("دبوس صاعد");
      buyScore += this.config.patternConfidence.pinBar;
    }

    const haramiAnalysis = this.isHarami(second, third);
    if (haramiAnalysis.isHarami && haramiAnalysis.direction === "BULLISH") {
      buyPatterns.push("هارامي صاعد");
      buyScore += this.config.patternConfidence.harami;
    }

    if (this.isShootingStar(third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi > this.config.rsiSellThreshold;
      if (rsiCondition) {
        sellPatterns.push(
          `الشهاب (RSI: ${indicators.rsi?.toFixed(1) || "N/A"})`,
        );
        sellScore += this.config.patternConfidence.shootingStar;
      }
    }

    if (this.isBearishEngulfing(second, third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi > this.config.rsiSellThreshold - 5;
      if (rsiCondition) {
        sellPatterns.push("الابتلاع البيعي");
        sellScore += this.config.patternConfidence.bearishEngulfing;
      }
    }

    if (this.isEveningStar(first, second, third)) {
      const rsiCondition =
        !indicators.rsi || indicators.rsi > this.config.rsiSellThreshold;
      if (rsiCondition) {
        sellPatterns.push("نجمة المساء");
        sellScore += this.config.patternConfidence.eveningStar;
      }
    }

    if (dojiAnalysis.isDoji && (!indicators.rsi || indicators.rsi > 70)) {
      sellPatterns.push(
        `دوجي في القمة (RSI: ${indicators.rsi?.toFixed(1) || "N/A"})`,
      );
      sellScore += this.config.patternConfidence.doji;
    }

    if (pinBarAnalysis.isPinBar && pinBarAnalysis.direction === "BEARISH") {
      sellPatterns.push("دبوس هابط");
      sellScore += this.config.patternConfidence.pinBar;
    }

    if (haramiAnalysis.isHarami && haramiAnalysis.direction === "BEARISH") {
      sellPatterns.push("هارامي هابط");
      sellScore += this.config.patternConfidence.harami;
    }

    if (
      this.isInvertedHammer(third) &&
      (!indicators.rsi || indicators.rsi > 65)
    ) {
      sellPatterns.push("مطرقة مقلوبة في القمة");
      sellScore += 12;
    }

    let recommendation = "NEUTRAL";
    let confidence = 0;

    if (buyScore > sellScore && buyScore > 20) {
      recommendation = "BUY";
      confidence = Math.min(100, buyScore);
    } else if (sellScore > buyScore && sellScore > 20) {
      recommendation = "SELL";
      confidence = Math.min(100, sellScore);
    } else if (Math.abs(buyScore - sellScore) < 10) {
      recommendation = "NEUTRAL";
      confidence = Math.max(buyScore, sellScore);
    }

    return {
      buyPatterns,
      sellPatterns,
      buyScore,
      sellScore,
      candleStrength,
      recommendation,
      confidence,
      currentCandle: this.calculateCandleMetrics(candles[candles.length - 1]),
      summary: this.generateSummary(
        buyPatterns,
        sellPatterns,
        recommendation,
        confidence,
      ),
    };
  }

  generateSummary(buyPatterns, sellPatterns, recommendation, confidence) {
    let summary = "";

    if (recommendation === "BUY") {
      summary = `إشارة شراء بقوة ${confidence}%\n`;
      summary += `أنماط الشراء: ${buyPatterns.join("، ")}`;
    } else if (recommendation === "SELL") {
      summary = `إشارة بيع بقوة ${confidence}%\n`;
      summary += `أنماط البيع: ${sellPatterns.join("، ")}`;
    } else {
      summary = `حيادي - لا توجد إشارات قوية`;
      if (buyPatterns.length > 0) {
        summary += `\nأنماط شراء ضعيفة: ${buyPatterns.join("، ")}`;
      }
      if (sellPatterns.length > 0) {
        summary += `\nأنماط بيع ضعيفة: ${sellPatterns.join("، ")}`;
      }
    }

    return summary;
  }
}

const CONFIG = {
  SYMBOLS: [
    "BTC/USDT",
    "BNB/USDT",
    "SOL/USDT",
    "ETH/USDT",
    "DOT/USDT",
    "ADA/USDT",
    "DOGE/USDT",
    "XRP/USDT",
    "MATIC/USDT",
    "1000CAT/USDT",
    "0G/USDT",
    "1000CHEEMS/USDT",
  ],
  MAX_CONCURRENT_TRADES: 5,
  MAX_SPREAD: 0.0012,
  UPDATE_INTERVAL: 60000,
  MAX_MONITOR_TIME: 120 * 60,
  COOLDOWN_TIME: 600000,
  CANDLE_LIMIT: 300,
  TIMEFRAME: "5m",
  MIN_CONFIDENCE: 83,
  MAX_RSI_ENTRY: 60,
  MIN_VOLUME_RATIO: 1.8,
};

class ProfessionalTradingSystem {
  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET_KEY,
      enableRateLimit: true,
    });

    this.fees = {};
    this.dbManager = new DatabaseManager();
    this.candleAnalyzer = null;
    this.orderBooks = {};
    this.activeTrades = [];
    this.cooldowns = {};
    this.marketData = {};
    this.wsHealth = {};
    this.lastAnalyzedCandle = {};
    this.lastSavedCandle = {};

    if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      this.tgBot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
        polling: false,
      });
      this.chatId = process.env.TELEGRAM_CHAT_ID;
    }

    this.performance = {
      trades: 0,
      wins: 0,
      losses: 0,
      netProfit: 0,
      totalConfidence: 0,
    };

    this.initLogs();
    this.sendTelegram("🏦 *بدء نظام التداول الاحترافي مع قاعدة بيانات*");
  }

  initLogs() {
    if (!fs.existsSync("professional_trades.csv")) {
      const headers =
        "Timestamp,Symbol,Entry,Exit,Pnl%,Pnl$,Confidence,RSI,VolumeRatio,Whales,Reasons\n";
      fs.writeFileSync("professional_trades.csv", headers);
    }
  }

  async sendTelegram(message) {
    if (!this.tgBot) return;
    try {
      await this.tgBot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
      });
    } catch (e) {
      console.error("Error sending Telegram:", e.message);
    }
  }

  async loadHistoricalData(symbol) {
    try {
      const dbCandles = await this.dbManager.getHistoricalCandles(
        symbol,
        CONFIG.TIMEFRAME,
        CONFIG.CANDLE_LIMIT,
      );

      if (dbCandles && dbCandles.length >= 220) {
        const candles = dbCandles
          .map((c) => [
            new Date(c.timestamp).getTime(),
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume,
          ])
          .sort((a, b) => a[0] - b[0]);

        this.marketData[symbol] = {
          candles,
          lastUpdate: Date.now(),
          source: "database",
        };

        console.log(
          `📊 ${symbol}: تم تحميل ${candles.length} شمعة من قاعدة البيانات`,
        );
        return true;
      }

      console.log(`📊 ${symbol}: جلب بيانات تاريخية من Binance...`);
      const freshCandles = await this.exchange.fetchOHLCV(
        symbol,
        CONFIG.TIMEFRAME,
        undefined,
        CONFIG.CANDLE_LIMIT,
      );

      if (freshCandles && freshCandles.length > 0) {
        for (const candle of freshCandles) {
          await this.dbManager.saveCandle(symbol, candle, CONFIG.TIMEFRAME);
        }

        this.marketData[symbol] = {
          candles: freshCandles,
          lastUpdate: Date.now(),
          source: "binance",
        };

        console.log(`✅ ${symbol}: تم جلب وحفظ ${freshCandles.length} شمعة`);
        return true;
      }

      return false;
    } catch (error) {
      console.error(`❌ خطأ في تحميل البيانات لـ ${symbol}:`, error.message);
      return false;
    }
  }

  async updateMarketData(symbol) {
    try {
      const latestCandles = await this.exchange.fetchOHLCV(
        symbol,
        CONFIG.TIMEFRAME,
        undefined,
        5,
      );

      if (latestCandles && latestCandles.length > 0) {
        let isNewCandle = false;
        const latestTimestamp = latestCandles[latestCandles.length - 2][0];

        if (
          !this.lastAnalyzedCandle[symbol] ||
          this.lastAnalyzedCandle[symbol] !== latestTimestamp
        ) {
          isNewCandle = true;
          this.lastAnalyzedCandle[symbol] = latestTimestamp;
        }

        if (!this.marketData[symbol]) {
          this.marketData[symbol] = { candles: [] };
        }

        let localCandles = this.marketData[symbol].candles;

        for (const candle of latestCandles) {
          const timestamp = candle[0];
          const index = localCandles.findIndex((c) => c[0] === timestamp);

          if (index !== -1) {
            localCandles[index] = candle;
          } else {
            localCandles.push(candle);
          }
        }

        localCandles.sort((a, b) => a[0] - b[0]);
        if (localCandles.length > CONFIG.CANDLE_LIMIT) {
          localCandles = localCandles.slice(-CONFIG.CANDLE_LIMIT);
        }

        this.marketData[symbol].candles = localCandles;
        this.marketData[symbol].lastUpdate = Date.now();

        const newCandles = [];
        const completedCandles = latestCandles.slice(0, -1);

        for (const candle of completedCandles) {
          const ts = candle[0];
          if (
            !this.lastSavedCandle[symbol] ||
            ts > this.lastSavedCandle[symbol]
          ) {
            newCandles.push(candle);
            this.lastSavedCandle[symbol] = ts;
          }
        }

        await Promise.all(
          newCandles.map((c) =>
            this.dbManager.saveCandle(symbol, c, CONFIG.TIMEFRAME),
          ),
        );
        return isNewCandle;
      }
    } catch (error) {
      console.error(`❌ خطأ في تحديث البيانات لـ ${symbol}:`, error.message);
    }
    return false;
  }

  async calculateTechnicalIndicators(symbol) {
    if (!this.marketData[symbol] || !this.marketData[symbol].candles)
      return null;

    const candles = this.marketData[symbol].candles;
    if (candles.length < 220) return null;

    const sortedCandles = [...candles].sort((a, b) => a[0] - b[0]);
    const completedCandles = sortedCandles.slice(0, -1);
    const lastCompletedCandle = completedCandles.at(-1);
    const completedCandleTs = lastCompletedCandle[0];

    const closes = completedCandles.map((c) => c[4]);
    const highs = completedCandles.map((c) => c[2]);
    const lows = completedCandles.map((c) => c[3]);
    const volumes = completedCandles.map((c) => c[5]);

    try {
      const rsiValues = TI.RSI.calculate({ values: closes, period: 14 });
      const currentRSI = rsiValues[rsiValues.length - 1];
      const prevRSI = rsiValues[rsiValues.length - 2];

      const rsiSMAValues = TI.SMA.calculate({ values: rsiValues, period: 20 });
      const currentRsiSMA = rsiSMAValues[rsiSMAValues.length - 1];

      const atrValues = TI.ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
      });
      const currentATR = atrValues[atrValues.length - 1];

      const volumeMA20 = TI.SMA.calculate({ values: volumes, period: 20 });
      const currentVolumeMA = volumeMA20[volumeMA20.length - 1] || 1;
      const lastCompletedVolume = volumes[volumes.length - 1] || 0;
      const volumeRatio = lastCompletedVolume / currentVolumeMA;

      const sma50Values = TI.SMA.calculate({ values: closes, period: 50 });
      const sma200Values = TI.SMA.calculate({ values: closes, period: 200 });

      const avgVolume = volumeMA20.at(-1) || 0;
      const lastClose = closes[closes.length - 1];
      const prevClose = closes[closes.length - 2];

      const candles48h = this.marketData[symbol].candles.slice(-96);
      const low24h = Math.min(...candles48h.map((c) => c[3]));
      const high24h = Math.max(...candles48h.map((c) => c[2]));

      const currentPrice = candles[candles.length - 1][4];
      const range = high24h - low24h || 1;
      const pricePosition = ((currentPrice - low24h) / range) * 100;

      if (this.lastAnalyzedCandle[symbol] === completedCandleTs) {
        await this.dbManager.saveTechnicalIndicators(symbol, {
          rsi: currentRSI,
          prevRsi: prevRSI,
          rsiSMA20: currentRsiSMA,
          close: lastClose,
          atr: currentATR,
          prevClose: prevClose,
          volumeRatio,
          avgVolume,
          sma50: sma50Values[sma50Values.length - 1],
          sma200: sma200Values[sma200Values.length - 1],
          pricePosition,
        });
      }

      return {
        rsi: currentRSI,
        prevRsi: prevRSI,
        rsiSMA20: currentRsiSMA,
        close: lastClose,
        atr: currentATR,
        prevClose: prevClose,
        volumeRatio,
        avgVolume,
        sma50: sma50Values[sma50Values.length - 1],
        sma200: sma200Values[sma200Values.length - 1],
        timestamp: Date.now(),
        pricePosition,
      };
    } catch (error) {
      console.error(`❌ خطأ في حساب المؤشرات لـ ${symbol}:`, error.message);
      return null;
    }
  }

  // ==================== دوال مساعدة ====================
  getSideRecommendation(totalScore, side) {
    if (side !== "BOTH") return side;

    if (totalScore > 70) return "LONG";
    if (totalScore < 30) return "SHORT";
    return "NEUTRAL";
  }

  async analyzeCandlestickPatterns(symbol, indicators = {}) {
    if (!this.candleAnalyzer) {
      this.candleAnalyzer = new analyzeCandle({
        marketData: this.marketData,
        config: {
          rsiBuyThreshold: 40,
          rsiSellThreshold: 60,
          minCandles: 5,
          patternConfidence: {
            hammer: 15,
            bullishEngulfing: 20,
            morningStar: 25,
            shootingStar: 15,
            bearishEngulfing: 20,
            eveningStar: 25,
            doji: 10,
            pinBar: 15,
            harami: 18,
          },
        },
      });
    }

    try {
      return await this.candleAnalyzer.analyzeCandlestickPatterns(
        symbol,
        indicators,
      );
    } catch (error) {
      console.error(`❌ خطأ في تحليل الشموع لـ ${symbol}:`, error.message);
      return {
        buyPatterns: [],
        sellPatterns: [],
        buyScore: 0,
        sellScore: 0,
        candleStrength: 0,
        recommendation: "NEUTRAL",
      };
    }
  }

  async calculateDecisionMatrix(symbol, orderBook, side = "BOTH") {
    const indicators = await this.calculateTechnicalIndicators(symbol);
    if (!indicators) return { confidence: 0, reasons: ["❌ بيانات غير كافية"] };

    let totalScore = 0;
    const reasons = [];
    const warnings = [];
    const pricePosition = indicators.pricePosition;

    const candleAnalysis = await this.analyzeCandlestickPatterns(
      symbol,
      indicators,
    );

    const whaleAnalysis = this.analyzeWhales(symbol, orderBook, indicators);
    totalScore += whaleAnalysis.score;
    reasons.push(...whaleAnalysis.reasons);

    if (side === "LONG" || side === "BOTH") {
      if (pricePosition <= 15) {
        totalScore += 15;
        reasons.push(`💎 السعر في أدنى 15% من نطاق اليوم`);
      } else if (pricePosition >= 70) {
        totalScore -= 10;
        warnings.push(`⚠️ السعر في أعلى 70% من نطاق اليوم`);
      }

      const ob = this.analyzeOrderBookDynamics(symbol, orderBook);
      if (ob.imbalance > 2.5) {
        totalScore += Math.min(20, (ob.imbalance - 2) * 10);
        reasons.push(`🌊 سيولة شراء (${ob.imbalance.toFixed(1)}x)`);
      }

      if (indicators.rsi < 40) {
        totalScore += 20;
        reasons.push(`📉 RSI منخفض (${indicators.rsi.toFixed(1)}) - تشبع بيع`);
      }

      if (candleAnalysis.buyPatterns.length > 0) {
        totalScore += candleAnalysis.buyScore;
        reasons.push(...candleAnalysis.buyPatterns.map((p) => `🟢 ${p}`));
      }
    }

    if (side === "SHORT" || side === "BOTH") {
      if (pricePosition >= 85) {
        totalScore += 15;
        reasons.push(`🔺 السعر في أعلى 15% من نطاق اليوم (بيع)`);
      }

      const bidVolume = orderBook.bids
        .slice(0, 15)
        .reduce((s, b) => s + b[0] * b[1], 0);
      const askVolume = orderBook.asks
        .slice(0, 15)
        .reduce((s, a) => s + a[0] * a[1], 0);
      const sellImbalance = bidVolume > 0 ? askVolume / bidVolume : 0;

      if (sellImbalance > 2.5) {
        totalScore += Math.min(20, (sellImbalance - 2) * 10);
        reasons.push(`🔻 ضغط بيع (${sellImbalance.toFixed(1)}x)`);
      }

      if (indicators.rsi > 60) {
        totalScore += 20;
        reasons.push(`📈 RSI مرتفع (${indicators.rsi.toFixed(1)}) - تشبع شراء`);
      }

      if (candleAnalysis.sellPatterns.length > 0) {
        totalScore += candleAnalysis.sellScore;
        reasons.push(...candleAnalysis.sellPatterns.map((p) => `🔴 ${p}`));
      }
    }

    const volatilityPct = (indicators.atr / indicators.close) * 100;
    if (volatilityPct > 3) {
      totalScore -= 15;
      warnings.push(`⚡ تقلب مرتفع (${volatilityPct.toFixed(2)}%)`);
    }

    const isBullish =
      indicators.close > indicators.sma50 &&
      indicators.sma50 > indicators.sma200;
    const isBearish =
      indicators.close < indicators.sma50 &&
      indicators.sma50 < indicators.sma200;

    if (isBullish && (side === "LONG" || side === "BOTH")) {
      totalScore += 15;
      reasons.push("🌊 اتجاه صاعد مؤسسي");
    }

    if (isBearish && (side === "SHORT" || side === "BOTH")) {
      totalScore += 15;
      reasons.push("📉 اتجاه هابط مؤسسي");
    }

    const confidence = Math.max(0, Math.min(100, Math.round(totalScore)));

    return {
      confidence,
      reasons,
      warnings,
      indicators,
      volatility: volatilityPct,
      pricePosition,
      sideRecommendation: this.getSideRecommendation(totalScore, side),
      whaleAnalysis,
    };
  }

  detectMarketRegime(ind) {
    const volatility = ind.atr / ind.close;
    const trendStrength = Math.abs(ind.sma50 - ind.sma200) / ind.close;

    if (volatility > 0.035) return "HIGH_VOLATILITY";
    if (trendStrength < 0.004) return "RANGE";
    if (ind.close > ind.sma50 && ind.sma50 > ind.sma200) return "UPTREND";
    if (ind.close < ind.sma50 && ind.sma50 < ind.sma200) return "DOWNTREND";

    return "TRANSITION";
  }

  analyzeWhales(symbol, orderBook, indicators) {
    const avgVolume = indicators.avgVolume;
    if (!orderBook || !orderBook.bids)
      return { score: 0, reasons: [], warnings: [], whales: [] };

    if (!this.volumeHistory) this.volumeHistory = {};
    this.volumeHistory[symbol] = { avgVolume };

    const dynamicThreshold = Math.min(
      Math.max(indicators.close * avgVolume * 0.001, 20000),
      indicators.close * avgVolume * 0.02,
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

    let wallThreshold = 100000;
    if (symbol.includes("BTC")) wallThreshold = 1500000;
    else if (symbol.includes("ETH")) wallThreshold = 700000;
    else if (symbol.includes("SOL")) wallThreshold = 250000;

    let bestCluster = { price: 0, volume: 0, count: 0 };

    for (let i = 0; i < 10; i++) {
      const price = orderBook.bids[i][0];
      const volume = price * orderBook.bids[i][1];

      if (volume > wallThreshold * 0.7) {
        let clusterVol = 0;
        let clusterCount = 0;

        orderBook.bids.slice(0, 15).forEach((b) => {
          if (Math.abs(b[0] - price) / price < 0.001) {
            clusterVol += b[0] * b[1];
            clusterCount++;
          }
        });

        if (clusterVol > bestCluster.volume) {
          bestCluster = { price, volume: clusterVol, count: clusterCount };
        }
      }
    }

    if (bestCluster.volume > wallThreshold) {
      score += 20;
      const formattedVol = (bestCluster.volume / 1000).toFixed(0) + "K";
      reasons.push(
        `🧱 تكتل سيولة (${bestCluster.count} جدران) بقوة $${formattedVol}`,
      );
    }

    return {
      score,
      imbalance,
      reasons,
      strongWall: bestCluster.volume > 0 ? bestCluster : null,
    };
  }

  async analyzeForEntry(symbol, orderBook) {
    const trendOk = await this.isTrendOk(symbol);
    if (!trendOk) {
      console.log(`⏭️ ${symbol}: مجهودك محفوظ - الترند مش مناسب`);
      return null;
    }

    const wsHealth = this.wsHealth?.[symbol];
    if (
      !wsHealth ||
      !wsHealth.stable ||
      Date.now() - wsHealth.lastUpdate > 2000
    ) {
      return null;
    }

    if (!orderBook || !orderBook.bids?.length || !orderBook.asks?.length) {
      return null;
    }

    if (orderBook.bids.length < 10 || orderBook.asks.length < 10) {
      return null;
    }

    if (this.activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) return null;
    if (this.activeTrades.some((t) => t.symbol === symbol)) return null;

    if (
      this.cooldowns?.[symbol] &&
      Date.now() - this.cooldowns[symbol] < CONFIG.COOLDOWN_TIME
    ) {
      return null;
    }

    const market = this.marketData?.[symbol];
    if (!market || market.candles.length < 50) {
      return null;
    }

    const obAnalysis = this.analyzeOrderBookDynamics(symbol, orderBook);
    if (!obAnalysis) return null;

    const decision = await this.calculateDecisionMatrix(symbol, orderBook);
    if (!decision || decision.confidence < CONFIG.MIN_CONFIDENCE) return null;

    const pricePosition = decision.pricePosition || 50;
    const indicators = decision.indicators;

    const bestBid = orderBook.bids[0][0];
    const bestAsk = orderBook.asks[0][0];
    const spread = (bestAsk - bestBid) / bestBid;

    if (spread > CONFIG.MAX_SPREAD) return null;

    if (
      obAnalysis.imbalance > 10 &&
      decision.whaleAnalysis?.whales?.length >= 5
    ) {
      this.sendTelegram(
        `💎 *Super Whale Alert*\n${symbol}\nImbalance: ${obAnalysis.imbalance.toFixed(1)}x\nWhales: ${decision.whaleAnalysis.whales.length}`,
      );
    }

    const entryPrice = bestAsk;
    const targets = this.calculateDynamicTargets(
      entryPrice,
      indicators,
      "LONG",
    );

    if (!targets || targets.riskRewardRatio < 1.3) return null;

    return {
      symbol,
      entryPrice,
      stopLoss: targets.stopLoss,
      takeProfit: targets.takeProfit.final || targets.takeProfit,
      confidence: decision.confidence,
      reasons: decision.reasons,
      warnings: decision.warnings,
      indicators,
      wallPrice: obAnalysis.strongWall?.price || null,
      initialWallVolume: obAnalysis.strongWall?.volume || 0,
      imbalanceAtEntry: obAnalysis.imbalance,
      whaleAnalysis: decision.whaleAnalysis,
      targets,
      spread,
      pricePosition,
      entryTime: Date.now(),
    };
  }

  async analyzeForOpportunities(symbol, orderBook) {
    const wsHealth = this.wsHealth?.[symbol];
    if (
      !wsHealth ||
      !wsHealth.stable ||
      Date.now() - wsHealth.lastUpdate > 2000
    ) {
      return null;
    }

    if (
      !orderBook ||
      orderBook.bids.length < 10 ||
      orderBook.asks.length < 10
    ) {
      return null;
    }

    if (this.activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) return null;
    if (this.activeTrades.some((t) => t.symbol === symbol)) return null;

    if (
      this.cooldowns?.[symbol] &&
      Date.now() - this.cooldowns[symbol] < CONFIG.COOLDOWN_TIME
    ) {
      return null;
    }

    const decision = await this.calculateDecisionMatrix(
      symbol,
      orderBook,
      "BOTH",
    );
    if (!decision || decision.confidence < CONFIG.MIN_CONFIDENCE) return null;
    if (decision.sideRecommendation === "NEUTRAL") return null;

    const spread =
      (orderBook.asks[0][0] - orderBook.bids[0][0]) / orderBook.bids[0][0];
    if (spread > CONFIG.MAX_SPREAD) return null;

    let entryPrice;
    if (decision.sideRecommendation === "LONG") {
      entryPrice = orderBook.asks[0][0];
    } else {
      entryPrice = orderBook.bids[0][0];
    }

    const targets = this.calculateDynamicTargets(
      entryPrice,
      decision.indicators,
      decision.sideRecommendation,
    );
    if (!targets || targets.riskRewardRatio < 1.3) return null;

    return {
      symbol,
      type: decision.sideRecommendation,
      entryPrice,
      stopLoss: targets.stopLoss,
      takeProfit: targets.takeProfit.final || targets.takeProfit,
      confidence: decision.confidence,
      reasons: decision.reasons,
      warnings: decision.warnings,
      indicators: decision.indicators,
      spread,
      pricePosition: decision.pricePosition,
      entryTime: Date.now(),
      trailingStop: targets.trailingStop,
    };
  }

  async isTrendOk(symbol) {
    const candles = this.marketData[symbol]?.candles;
    if (!candles || candles.length < 50) return false;

    const completedCandles = candles.slice(0, -1);
    if (completedCandles.length < 50) return false;

    const closes = completedCandles.map((c) => c[4]);
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];

    const sma20 = closes.slice(-20).reduce((a, b) => a + b) / 20;
    const sma50 = closes.slice(-50).reduce((a, b) => a + b) / 50;

    const momentum = lastClose > prevClose;

    if (lastClose > sma20) {
      console.log(
        `✅ ${symbol}: فوق SMA20 (${lastClose.toFixed(4)} > ${sma20.toFixed(4)})`,
      );
      return true;
    }

    if (lastClose > sma50 && momentum) {
      console.log(`⚠️ ${symbol}: تحت SMA20 لكن فوق SMA50 مع زخم إيجابي`);
      return true;
    }

    const indicators = await this.calculateTechnicalIndicators(symbol);
    if (indicators) {
      const hasStrongRSI = indicators.rsi < 35;
      const hasStrongVolume = indicators.volumeRatio > 2.5;

      if (hasStrongRSI && hasStrongVolume) {
        console.log(
          `⚠️ ${symbol}: تحت المتوسطات لكن مع RSI ${indicators.rsi.toFixed(1)} وحجم ${indicators.volumeRatio.toFixed(1)}x`,
        );
        return true;
      }
    }

    console.log(
      `⛔ ${symbol}: الترند هابط قوي (${lastClose.toFixed(4)} < SMA50 ${sma50.toFixed(4)})`,
    );
    return false;
  }

  calculateDynamicTargets(entryPrice, indicators, side) {
    const atr = indicators.atr || entryPrice * 0.01;
    let stopLoss, takeProfit, trailingStop;

    if (side === "LONG") {
      stopLoss = entryPrice - atr * 3;
      takeProfit = {
        tp1: entryPrice + atr * 2,
        tp2: entryPrice + atr * 4,
        tp3: entryPrice + atr * 6,
        final: entryPrice + atr * 10,
      };
      trailingStop = {
        activated: false,
        startProfit: 0.008,
        distance: atr * 1.5,
        current: stopLoss,
      };
    } else {
      stopLoss = entryPrice + atr * 3;
      takeProfit = {
        tp1: entryPrice - atr * 2,
        tp2: entryPrice - atr * 4,
        tp3: entryPrice - atr * 6,
        final: entryPrice - atr * 10,
      };
      trailingStop = {
        activated: false,
        startProfit: 0.008,
        distance: atr * 1.5,
        current: stopLoss,
      };
    }

    let riskAmount;
    if (side === "LONG") {
      riskAmount = entryPrice - stopLoss;
    } else {
      riskAmount = stopLoss - entryPrice;
    }

    const rewardAmount =
      side === "LONG"
        ? takeProfit.final - entryPrice
        : entryPrice - takeProfit.final;
    const riskRewardRatio = rewardAmount / riskAmount;

    return {
      stopLoss: Number(stopLoss.toFixed(8)),
      takeProfit: takeProfit,
      trailingStop: trailingStop,
      riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
      atrValue: atr,
      stopLossPercent: ((riskAmount / entryPrice) * 100).toFixed(2) + "%",
      targetPercent: ((rewardAmount / entryPrice) * 100).toFixed(2) + "%",
    };
  }

  async getMyActualBalance() {
    try {
      const usdtBalance = 1000;
      console.log(`💰 رصيدك الحالي في باينانس: ${usdtBalance.toFixed(2)} USDT`);
      return usdtBalance;
    } catch (error) {
      console.error("❌ فشل في جلب الرصيد:", error.message);
      return 0;
    }
  }

  async executeTrade(opportunity) {
    try {
      const myBalance = await this.getMyActualBalance();
      if (myBalance <= 0) {
        console.log("⚠️ الرصيد غير متاح أو صفر");
        return;
      }

      const minRequiredBalance = 50;
      if (myBalance < minRequiredBalance) {
        console.log(
          `⚠️ الرصيد الحالي ($${myBalance.toFixed(2)}) منخفض جداً للدخول`,
        );
        return;
      }

      const riskPerTradePercent = 1.5;
      const priceRiskPercent =
        ((opportunity.entryPrice - opportunity.stopLoss) /
          opportunity.entryPrice) *
        100;
      const maxRiskAmount = myBalance * (riskPerTradePercent / 100);
      const positionSizeBasedOnRisk = maxRiskAmount / (priceRiskPercent / 100);

      const baseRiskMultiplier =
        opportunity.confidence > 92
          ? 0.2
          : opportunity.confidence > 85
            ? 0.1
            : 0.015;

      const confidenceWeight = Math.min(1.5, opportunity.confidence / 100);
      const whaleCount = opportunity.whaleAnalysis.whales?.length || 0;
      const whaleWeight = Math.min(1.3, 1 + whaleCount * 0.1);
      const imbalance = opportunity.imbalanceAtEntry || 1;
      const imbalanceWeight = Math.min(1.5, 1 + (imbalance - 1) * 0.2);

      let tradeSize =
        myBalance *
        baseRiskMultiplier *
        confidenceWeight *
        whaleWeight *
        imbalanceWeight;

      const minSize1 = 100;
      const minSize2 = myBalance * 0.15;
      const minTradeSize = Math.max(minSize1, minSize2);
      const maxSize1 = myBalance * 0.5;
      const maxSize2 = positionSizeBasedOnRisk;
      const maxTradeSize = Math.min(maxSize1, maxSize2);
      const absoluteMax = 1000;

      tradeSize = Math.max(tradeSize, minTradeSize);
      tradeSize = Math.min(tradeSize, maxTradeSize);
      tradeSize = Math.min(tradeSize, absoluteMax);

      if (tradeSize > myBalance * 0.9) {
        tradeSize = myBalance * 0.8;
        console.log(`⚠️ ضبط الحجم لـ 80% من الرصيد للحماية`);
      }

      const riskAmount = tradeSize * (priceRiskPercent / 100);
      const riskToBalancePercent = (riskAmount / myBalance) * 100;

      if (riskToBalancePercent > 3) {
        console.log(
          `⛔ مخاطرة عالية جداً (${riskToBalancePercent.toFixed(2)}%) - إلغاء الصفقة`,
        );
        this.sendTelegram(
          `⛔ *مخاطرة عالية*: ${opportunity.symbol} - ${riskToBalancePercent.toFixed(2)}%`,
        );
        return;
      }

      console.log(`📊 حساب حجم الصفقة لـ ${opportunity.symbol}:`);
      console.log(`   - الرصيد: $${myBalance.toFixed(2)}`);
      console.log(
        `   - نسبة المخاطرة السعرية: ${priceRiskPercent.toFixed(2)}%`,
      );
      console.log(
        `   - الثقة: ${opportunity.confidence}% → وزن: ${confidenceWeight.toFixed(2)}`,
      );
      console.log(
        `   - عدد الحيتان: ${whaleCount} → وزن: ${whaleWeight.toFixed(2)}`,
      );
      console.log(
        `   - الانحراف: ${imbalance.toFixed(2)}x → وزن: ${imbalanceWeight.toFixed(2)}`,
      );
      console.log(`   - الحجم المحسوب: $${tradeSize.toFixed(2)}`);
      console.log(
        `   - المخاطرة الفعلية: $${riskAmount.toFixed(2)} (${riskToBalancePercent.toFixed(2)}% من الرصيد)`,
      );

      const trade = {
        id: `TRADE_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        symbol: opportunity.symbol,
        entryPrice: opportunity.entryPrice,
        entryTime: Date.now(),
        size: tradeSize,
        riskAmount: riskAmount,
        riskPercent: priceRiskPercent,
        riskToBalancePercent: riskToBalancePercent,
        wallPrice: opportunity.wallPrice,
        initialWallVolume: opportunity.initialWallVolume,
        imbalanceAtEntry: opportunity.imbalanceAtEntry,
        stopLoss: opportunity.stopLoss,
        takeProfit: opportunity.takeProfit,
        status: "ACTIVE",
        confidence: opportunity.confidence,
        reasons: opportunity.reasons,
        rsi: opportunity.indicators.rsi,
        volumeRatio: opportunity.indicators.volumeRatio,
        atr: opportunity.indicators.atr,
        highestPrice: opportunity.entryPrice,
        currentStopLoss: opportunity.stopLoss,
        stopLossHistory: [
          {
            price: opportunity.stopLoss,
            time: Date.now(),
            reason: "Initial",
            riskPercent: priceRiskPercent,
          },
        ],
        pricePosition: opportunity.pricePosition,
        whaleCount: whaleCount,
        calculationDetails: {
          balance: myBalance,
          confidenceWeight: confidenceWeight,
          whaleWeight: whaleWeight,
          imbalanceWeight: imbalanceWeight,
          positionSizingMethod: "Intelligent Risk-Based",
        },
      };

      const isAlreadyOpen = this.activeTrades.find(
        (t) => t.symbol === trade.symbol,
      );
      if (isAlreadyOpen) {
        console.log(`⏸️ ${trade.symbol}: صفقة نشطة بالفعل`);
        return;
      }

      if (this.activeTrades.length >= CONFIG.MAX_CONCURRENT_TRADES) {
        console.log(
          `⏸️ وصلت للحد الأقصى للصفقات (${CONFIG.MAX_CONCURRENT_TRADES})`,
        );
        return;
      }

      this.activeTrades.push(trade);

      const whaleIcons = "🐋".repeat(Math.min(whaleCount, 3));
      const riskRewardRatio = (
        (opportunity.takeProfit - opportunity.entryPrice) /
        (opportunity.entryPrice - opportunity.stopLoss)
      ).toFixed(2);

      this.sendTelegram(
        `🚀 *دخول جديد: ${trade.symbol}* [15M]\n\n` +
          `💵 *الحجم:* $${tradeSize.toFixed(2)}\n` +
          `💰 *السعر:* $${opportunity.entryPrice.toFixed(4)}\n` +
          `🛡️ *الستوب:* $${opportunity.stopLoss.toFixed(4)} (${priceRiskPercent.toFixed(2)}%)\n` +
          `🎯 *الهدف:* $${opportunity.takeProfit.toFixed(4)}\n` +
          `⚖️ *R/R:* ${riskRewardRatio}:1\n` +
          `⚠️ *المخاطرة:* $${riskAmount.toFixed(2)} (${riskToBalancePercent.toFixed(2)}% من الرصيد)\n` +
          `📊 *الرصيد:* $${myBalance.toFixed(2)}\n` +
          `🔮 *الثقة:* ${opportunity.confidence}% ${whaleIcons}\n` +
          `📈 *RSI:* ${opportunity.indicators.rsi.toFixed(1)}\n` +
          `💧 *الحجم:* ${opportunity.indicators.volumeRatio.toFixed(1)}x\n` +
          `📝 *الأسباب:*\n${opportunity.reasons
            .slice(0, 3)
            .map((r) => `• ${r}`)
            .join("\n")}`,
      );

      this.startProfessionalMonitoring(trade);
      console.log(
        `✅ تم تنفيذ صفقة ${trade.symbol} بحجم $${tradeSize.toFixed(2)}`,
      );
    } catch (error) {
      console.error("❌ خطأ تنفيذ:", error);
      this.sendTelegram(`❌ *خطأ في تنفيذ الصفقة:* ${error.message}`);
    }
  }

  startProfessionalMonitoring(trade) {
    const monitor = async () => {
      if (trade.status !== "ACTIVE") return;

      const orderBook = this.orderBooks[trade.symbol];
      if (!orderBook) return;

      const currentPrice = orderBook.bids[0][0];
      if (currentPrice > trade.highestPrice) {
        trade.highestPrice = currentPrice;
      }

      const currentProfit =
        ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
      const feePercent = (this.fees[trade.symbol]?.taker || 0.001) * 2 * 100;
      const netProfit = currentProfit - feePercent;

      const currentIndicators = await this.calculateTechnicalIndicators(
        trade.symbol,
      );
      if (!currentIndicators || !currentIndicators.atr) {
        setTimeout(monitor, 2000);
        return;
      }

      const activeATR = trade.atr * 0.7 + currentIndicators.atr * 0.3;
      this.updateTrailingStop(trade, currentPrice, currentProfit, activeATR);
      const exitDecision = this.shouldExit(
        trade,
        currentPrice,
        netProfit,
        orderBook,
      );

      if (exitDecision.exit) {
        trade.status = "CLOSED";
        await this.dbManager.saveTrade({
          id: trade.id,
          symbol: trade.symbol,
          entryPrice: trade.entryPrice,
          exitPrice: currentPrice,
          entryTime: trade.entryTime,
          exitTime: Date.now(),
          pnlPercent: netProfit,
          pnlUsd: (netProfit / 100) * trade.size,
          confidence: trade.confidence,
          rsiValue: trade.rsi,
          volumeRatio: trade.volumeRatio,
          whalePower: 0,
          reasons: trade.reasons.join(" | "),
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          exitReason: exitDecision.reason,
          duration: (Date.now() - trade.entryTime) / 1000,
          pricePosition: trade.pricePosition,
        });

        this.closeTrade(trade, currentPrice, netProfit, exitDecision.reason);
        this.cooldowns[trade.symbol] = Date.now();
        return;
      }

      setTimeout(monitor, 2000);
    };

    setTimeout(monitor, 2000);
  }

  updateTrailingStop(trade, currentPrice, currentProfit, activeATR) {
    if (currentProfit > 1.5 && trade.currentStopLoss < trade.entryPrice) {
      trade.currentStopLoss = trade.entryPrice * 1.01;
      trade.stopLossHistory.push({
        price: trade.currentStopLoss,
        time: Date.now(),
        reason: "تأمين ربح 1%",
      });
    }

    if (
      currentProfit > 3.0 &&
      trade.currentStopLoss < trade.entryPrice * 1.02
    ) {
      trade.currentStopLoss = trade.entryPrice * 1.02;
      trade.stopLossHistory.push({
        price: trade.currentStopLoss,
        time: Date.now(),
        reason: "تأمين ربح 2%",
      });
    }

    if (currentProfit >= 5.0 && !trade.partialExitTaken) {
      trade.currentStopLoss = trade.entryPrice * 1.035;
      trade.stopLossHistory.push({
        price: trade.currentStopLoss,
        time: Date.now(),
        reason: "تأمين ربح 3.5% (جاهز للخروج الجزئي)",
      });
      trade.partialExitTaken = true;
      console.log(`💰 ${trade.symbol}: وصلنا 5% ربح - جاهز للخروج الجزئي`);
    }

    if (currentProfit > 8.0) {
      const atrMultiplier = 3.5;
      const atrTrailingStopPrice = currentPrice - activeATR * atrMultiplier;
      if (atrTrailingStopPrice > trade.currentStopLoss) {
        trade.currentStopLoss = atrTrailingStopPrice;
        trade.stopLossHistory.push({
          price: trade.currentStopLoss,
          time: Date.now(),
          reason: `تريلينج بعد 8% ربح (ATR: ${activeATR.toFixed(4)})`,
        });
      }
    }
  }

  shouldExit(trade, currentPrice, netProfit, orderBook) {
    const obDynamics = this.analyzeOrderBookDynamics(trade.symbol, orderBook);

    if (trade.wallPrice) {
      const currentWall = orderBook.bids.find(
        (b) => Math.abs(b[0] - trade.wallPrice) < trade.entryPrice * 0.0001,
      );
      const currentWallVolume = currentWall
        ? currentWall[0] * currentWall[1]
        : 0;
      const wallVolumeRatio = currentWallVolume / trade.initialWallVolume;

      if (wallVolumeRatio < 0.1 && Date.now() - trade.entryTime < 30000) {
        const isActuallyLosing = currentPrice < trade.entryPrice * 0.997;
        const isImbalanceFlipped = obDynamics.imbalance < 0.6;

        if (isActuallyLosing && isImbalanceFlipped) {
          return { exit: true, reason: "CONFIRMED_SPOOFING_EXIT" };
        }
      }
    }

    if (
      obDynamics.strongWall &&
      obDynamics.strongWall.price > trade.currentStopLoss &&
      obDynamics.strongWall.price < currentPrice * 0.998
    ) {
      trade.currentStopLoss = obDynamics.strongWall.price * 0.9995;
      console.log(`🛡️ ${trade.symbol}: رفعنا الستوب خلف حوت جديد دخل الساحة.`);
    }

    if (currentPrice <= trade.currentStopLoss) {
      return {
        exit: true,
        reason:
          trade.currentStopLoss > trade.entryPrice
            ? "TRAILED_PROFIT_TAKEN"
            : "STOP_LOSS_HIT",
      };
    }

    const targetPrice =
      typeof trade.takeProfit === "object"
        ? trade.takeProfit.final
        : trade.takeProfit;
    if (currentPrice >= targetPrice) {
      if (obDynamics.imbalance > 3.5) {
        trade.currentStopLoss = currentPrice * 0.994;
        trade.takeProfit = currentPrice * 1.012;
        console.log(
          `🚀 ${trade.symbol}: انفجار فوليوم! رحلنا الهدف للصيد الأكبر.`,
        );
        return { exit: false };
      }
      return { exit: true, reason: "TAKE_PROFIT_REACHED" };
    }

    if (netProfit > 0.6 && obDynamics.imbalance < 0.2) {
      return { exit: true, reason: "MOMENTUM_LOST_SECURED" };
    }

    const tradeDurationMinutes = (Date.now() - trade.entryTime) / 60000;
    if (tradeDurationMinutes > CONFIG.MAX_MONITOR_TIME) {
      if (Math.abs(netProfit) < 0.2) {
        return { exit: true, reason: "TIME_LIMIT_STAGNANT" };
      }
    }

    return { exit: false, reason: "" };
  }

  async closeTrade(trade, exitPrice, netPnlPercent, reason) {
    const netPnlUsd = (netPnlPercent / 100) * trade.size;
    const duration = (Date.now() - trade.entryTime) / 60000;

    this.performance.trades++;
    this.performance.netProfit += netPnlUsd;
    this.performance.totalConfidence += trade.confidence;

    if (netPnlPercent > 0) {
      this.performance.wins++;
    } else {
      this.performance.losses++;
    }

    const log = `${new Date().toISOString()},${trade.symbol},${trade.entryPrice.toFixed(4)},${exitPrice.toFixed(4)},${netPnlPercent.toFixed(3)}%,${netPnlUsd.toFixed(3)},${trade.confidence.toFixed(1)},${trade.rsi.toFixed(1)},${trade.volumeRatio.toFixed(1)},${trade.stopLossHistory.length - 1},"${trade.reasons.slice(0, 2).join(" | ")}"\n`;
    fs.appendFileSync("professional_trades.csv", log);

    let emoji = "📊";
    if (reason.includes("PROFIT")) emoji = "💰";
    if (reason.includes("STOP_LOSS")) emoji = "🛑";
    if (reason.includes("TAKE_PROFIT")) emoji = "🎯";

    this.sendTelegram(
      `${emoji} *${trade.symbol} - إغلاق*\n\n` +
        `📊 ${netPnlPercent > 0 ? "+" : ""}${netPnlPercent.toFixed(2)}%\n` +
        `💸 ${netPnlUsd > 0 ? "+" : ""}$${netPnlUsd.toFixed(2)}\n` +
        `⏱️ ${duration.toFixed(1)} دقيقة\n` +
        `🛑 ${trade.stopLossHistory.length - 1} حركة ستوب\n` +
        `📝 ${this.translateReason(reason)}\n` +
        `🎯 الثقة: ${trade.confidence.toFixed(1)}%\n` +
        `🕐 ${new Date().toLocaleTimeString("ar-SA")}`,
    );

    this.activeTrades = this.activeTrades.filter((t) => t.id !== trade.id);
  }

  translateReason(englishReason) {
    const reasons = {
      TRAILING_STOP_PROFIT: "تريلينج ستوب مع ربح",
      STOP_LOSS: "وصول للستوب لوز",
      TAKE_PROFIT: "تحقيق الهدف",
      MARKET_CONDITION_DETERIORATED: "تدهور ظروف السوق",
      TIME_LIMIT_PROFIT: "انتهاء الوقت مع ربح",
      TIME_LIMIT_LOSS: "انتهاء الوقت",
      WHALES_DISAPPEARED: "اختفاء الحيتان",
      CONFIRMED_SPOOFING_EXIT: "خدعة الحيتان - خروج",
      TRAILED_PROFIT_TAKEN: "تأمين ربح بالتريلينج",
      MOMENTUM_LOST_SECURED: "ضعف الزخم مع تأمين الربح",
      TIME_LIMIT_STAGNANT: "انتهاء الوقت مع ركود",
    };
    return reasons[englishReason] || englishReason;
  }

  generatePowerBar(imbalance) {
    const totalChars = 8;
    let greenCount = Math.min(
      totalChars,
      Math.max(1, Math.floor((imbalance / 2) * totalChars)),
    );
    if (imbalance > 2) greenCount = totalChars;
    const redCount = totalChars - greenCount;
    return "🟩".repeat(greenCount) + "🟥".repeat(redCount);
  }

  async sendMonitoringReport() {
    try {
      let report = "🔍 *تقرير الرادار اللحظي المطور*\n\n";
      const validOpportunities = [];

      for (const symbol of CONFIG.SYMBOLS) {
        const orderBook = this.orderBooks[symbol];
        if (!orderBook) continue;

        const decision = await this.calculateDecisionMatrix(symbol, orderBook);
        if (decision && decision.indicators) {
          validOpportunities.push({
            symbol,
            confidence: decision.confidence,
            decision,
            orderBookData: this.analyzeOrderBookDynamics(symbol, orderBook),
          });
        }
      }

      if (validOpportunities.length === 0) {
        return this.sendTelegram("⏳ جاري تجميع بيانات كافية للرادار...");
      }

      validOpportunities.sort((a, b) => b.confidence - a.confidence);

      validOpportunities.slice(0, 5).forEach((item, index) => {
        const { symbol, confidence, decision, orderBookData } = item;
        const ind = decision.indicators;

        const powerBar = this.generatePowerBar(orderBookData.imbalance);

        report += `${index + 1}. *${symbol}* (${confidence.toFixed(1)}%)\n`;
        report += `   ⚖️ السيولة: ${powerBar} (${orderBookData.imbalance.toFixed(1)}x)\n`;
        report += `   • RSI: ${ind.rsi.toFixed(1)} | حجم: ${ind.volumeRatio.toFixed(1)}x\n`;
        report += `   • ATR: $${ind.atr.toFixed(4)} | موقع السعر: ${decision.pricePosition}\n`;

        const hasWall = orderBookData.reasons.find((r) => r.includes("🧱"));
        if (hasWall) report += `   ${hasWall}\n`;

        report += `   • الحالة: ${confidence >= CONFIG.MIN_CONFIDENCE ? "🚀 دخول" : "📉 مراقبة"}\n`;
        report += `--------------------------\n`;
      });

      this.sendTelegram(report);
    } catch (error) {
      console.error("❌ خطأ في إرسال التقرير:", error.message);
    }
  }

  connectWebSockets() {
    CONFIG.SYMBOLS.forEach((symbol) => {
      this.connectSingleSymbolWS(symbol);
    });
  }

  connectSingleSymbolWS(symbol) {
    const streamName = symbol.replace("/", "").toLowerCase();
    const ws = new WebSocket(
      `wss://stream.binance.com:9443/ws/${streamName}@depth20@100ms`,
    );

    if (!this.wsHealth) this.wsHealth = {};
    this.wsHealth[symbol] = {
      stable: false,
      ticks: 0,
      lastUpdate: 0,
      lastBestBid: null,
    };

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data);

        if (
          !parsed.bids ||
          !parsed.asks ||
          parsed.bids.length < 10 ||
          parsed.asks.length < 10
        ) {
          return;
        }

        const bids = parsed.bids.map((b) => [Number(b[0]), Number(b[1])]);
        const asks = parsed.asks.map((a) => [Number(a[0]), Number(a[1])]);

        const bestBid = bids[0][0];
        const health = this.wsHealth[symbol];

        if (health.lastBestBid === bestBid) return;

        health.lastBestBid = bestBid;
        health.lastUpdate = Date.now();
        health.ticks++;

        if (health.ticks >= 3) {
          health.stable = true;
        }

        this.orderBooks[symbol] = { bids, asks };
      } catch (_) {
        // تجاهل أي خطأ parsing بدون crash
      }
    });

    ws.on("error", (err) => {
      console.error(`❌ WS Error for ${symbol}:`, err.message);
      if (this.wsHealth[symbol]) {
        this.wsHealth[symbol].stable = false;
        this.wsHealth[symbol].ticks = 0;
      }
      ws.close();
    });

    ws.on("close", () => {
      console.log(`🔄 Reconnecting WebSocket for ${symbol}...`);
      if (this.wsHealth[symbol]) {
        this.wsHealth[symbol].stable = false;
        this.wsHealth[symbol].ticks = 0;
      }
      setTimeout(() => this.connectSingleSymbolWS(symbol), 5000);
    });
  }

  async start() {
    this.sendTelegram("🏦 *بدء النظام الاحترافي مع قاعدة بيانات SQLite*");
    setInterval(
      async () => {
        await this.dbManager.cleanupOldData(2);
      },
      24 * 60 * 60 * 1000,
    );

    await this.exchange.loadMarkets();
    this.fees = {};

    for (const s of CONFIG.SYMBOLS) {
      const market = this.exchange.markets[s];
      this.fees[s] = {
        maker: market.maker || 0.001,
        taker: market.taker || 0.001,
      };
    }

    console.log("✅ الرسوم لكل رمز تم تحميلها:", this.fees);

    this.sendTelegram("📊 *جاري تحميل البيانات التاريخية...*");
    for (const symbol of CONFIG.SYMBOLS) {
      const loaded = await this.loadHistoricalData(symbol);
      if (loaded) {
        this.sendTelegram(`✅ ${symbol}: تم تحميل البيانات التاريخية`);
      } else {
        this.sendTelegram(`❌ ${symbol}: فشل تحميل البيانات`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.connectWebSockets();

    let isUpdatingMarketData = false;
    setInterval(async () => {
      if (isUpdatingMarketData) return;
      isUpdatingMarketData = true;

      try {
        for (const symbol of CONFIG.SYMBOLS) {
          await this.updateMarketData(symbol);
        }
      } catch (e) {
        console.error("❌ Market Data Update Error:", e.message);
      } finally {
        isUpdatingMarketData = false;
      }
    }, 60000);

    let isScanning = false;
    setInterval(async () => {
      if (isScanning) return;
      isScanning = true;

      try {
        for (const symbol of CONFIG.SYMBOLS) {
          const opp = await this.analyzeForEntry(
            symbol,
            this.orderBooks[symbol],
          );
          if (opp) await this.executeTrade(opp);
        }
      } catch (e) {
        console.error("❌ Scan Error:", e.message);
      } finally {
        isScanning = false;
      }
    }, CONFIG.UPDATE_INTERVAL);

    setInterval(async () => {
      const stats = await this.dbManager.getTradeStatistics();
      if (stats) {
        this.sendTelegram(
          `📈 *تقرير إحصائي كل ساعة*\n\n` +
            `📊 إجمالي الصفقات: ${stats.total_trades}\n` +
            `💰 الصفقات الرابحة: ${stats.winning_trades}\n` +
            `📉 الصفقات الخاسرة: ${stats.losing_trades}\n` +
            `📊 متوسط الربح: ${stats.avg_pnl_percent?.toFixed(2) || 0}%\n` +
            `💸 إجمالي الربح: $${stats.total_pnl_usd?.toFixed(2) || 0}\n` +
            `🎛️ متوسط الثقة: ${stats.avg_confidence?.toFixed(1) || 0}%\n` +
            `⏱️ متوسط المدة: ${(stats.avg_duration / 60)?.toFixed(1) || 0} دقيقة`,
        );
      }
    }, 3 * 3600000);

    let isMonitoring = false;
    setInterval(async () => {
      if (isMonitoring) return;
      isMonitoring = true;

      try {
        await this.sendMonitoringReport();
      } catch (e) {
        console.error("❌ Monitoring Report Error:", e.message);
      } finally {
        isMonitoring = false;
      }
    }, 3 * 3600000);

    this.sendTelegram("✅ *النظام يعمل بنجاح مع قاعدة بيانات SQLite*");
  }
}

process.on("SIGINT", async () => {
  const bot = global.botInstance;
  if (bot && bot.tgBot) {
    const stats = await bot.dbManager.getTradeStatistics();

    await bot.sendTelegram(
      `🛑 *إغلاق النظام الاحترافي*\n\n` +
        `📊 إجمالي الصفقات: ${bot.performance.trades}\n` +
        `💰 الربح الصافي: $${bot.performance.netProfit.toFixed(2)}\n` +
        `🏆 النجاح: ${bot.performance.wins}/${bot.performance.trades}\n` +
        `🎛️ متوسط الثقة: ${(bot.performance.totalConfidence / (bot.performance.trades || 1)).toFixed(1)}%\n\n` +
        `💾 *بيانات قاعدة البيانات:*\n` +
        `📈 إجمالي السجلات: ${stats?.total_trades || 0}\n` +
        `📊 متوسط الربح: ${stats?.avg_pnl_percent?.toFixed(2) || 0}%\n` +
        `⏱️ ${new Date().toLocaleTimeString("ar-SA")}`,
    );
  }
  setTimeout(() => process.exit(0), 1000);
});

const bot = new ProfessionalTradingSystem();
global.botInstance = bot;
bot.start();
