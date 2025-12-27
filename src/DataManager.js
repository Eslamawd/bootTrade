const TI = require("technicalindicators");

class DataManager {
  constructor(exchange, dbManager, config) {
    this.exchange = exchange;
    this.db = dbManager;
    this.config = config;
    this.marketData = {};
  }

  async initSymbols(symbols) {
    for (const symbol of symbols) {
      for (const tf of ["5m", "15m", "1h"]) {
        await this.loadHistoricalData(symbol, tf);
      }
    }
  }

  async loadHistoricalData(symbol, timeframe) {
    try {
      let candles = await this.db.getHistoricalCandles(
        symbol,
        timeframe,
        this.config.CANDLE_LIMIT
      );

      if (!candles || candles.length < 50) {
        console.log(`📊 ${symbol} [${timeframe}]: جلب بيانات من Binance...`);
        const fresh = await this.exchange.fetchOHLCV(
          symbol,
          timeframe,
          undefined,
          this.config.CANDLE_LIMIT
        );
        for (const c of fresh) await this.db.saveCandle(symbol, c, timeframe);
        candles = fresh;
      } else {
        candles = candles.map((c) => [
          new Date(c.timestamp).getTime(),
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
        ]);
      }

      this.storeData(symbol, timeframe, candles);
      return true;
    } catch (e) {
      console.error(`❌ خطأ تحميل ${symbol} ${timeframe}:`, e.message);
      return false;
    }
  }

  async updateSymbol(symbol, timeframe) {
    try {
      const latest = await this.exchange.fetchOHLCV(
        symbol,
        timeframe,
        undefined,
        5
      );
      if (!latest || latest.length === 0) return;

      if (!this.marketData[symbol]) this.marketData[symbol] = {};
      if (!this.marketData[symbol][timeframe])
        this.marketData[symbol][timeframe] = { candles: [] };

      let local = this.marketData[symbol][timeframe].candles;

      for (const candle of latest) {
        const idx = local.findIndex((c) => c[0] === candle[0]);
        if (idx !== -1) local[idx] = candle;
        else local.push(candle);
        await this.db.saveCandle(symbol, candle, timeframe);
      }

      this.marketData[symbol][timeframe].candles = local
        .sort((a, b) => a[0] - b[0])
        .slice(-this.config.CANDLE_LIMIT);

      // تحديث المؤشرات لهذا الفريم تحديداً
      this.marketData[symbol][timeframe].indicators =
        this.calculateTechnicalIndicators(symbol, timeframe);
    } catch (e) {
      console.error(`❌ خطأ تحديث ${symbol}:`, e.message);
    }
  }

  // تعديل: تمرير الـ timeframe لضمان دقة الحساب لكل فريم على حدة
  calculateTechnicalIndicators(symbol, timeframe) {
    if (!this.marketData[symbol] || !this.marketData[symbol][timeframe])
      return null;

    const candles = this.marketData[symbol][timeframe].candles;
    if (candles.length < 50) return null;

    const sortedCandles = [...candles].sort((a, b) => a[0] - b[0]);
    const completedCandles = sortedCandles.slice(0, -1); // التركيز على الشموع المغلقة

    const closes = completedCandles.map((c) => c[4]);
    const highs = completedCandles.map((c) => c[2]);
    const lows = completedCandles.map((c) => c[3]);
    const volumes = completedCandles.map((c) => c[5]);

    try {
      const rsiValues = TI.RSI.calculate({ values: closes, period: 14 });
      const rsiSMAValues = TI.SMA.calculate({ values: rsiValues, period: 20 });
      const atrValues = TI.ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
      });
      const volumeMA20 = TI.SMA.calculate({ values: volumes, period: 20 });
      const sma50Values = TI.SMA.calculate({ values: closes, period: 50 });
      const sma200Values = TI.SMA.calculate({ values: closes, period: 200 });

      return {
        rsi: rsiValues.at(-1),
        prevRsi: rsiValues.at(-2),
        rsiSMA20: rsiSMAValues.at(-1),
        close: closes.at(-1),
        prevClose: closes.at(-2),
        atr: atrValues.at(-1),
        volumeRatio: volumes.at(-1) / (volumeMA20.at(-1) || 1),
        avgVolume: volumeMA20.at(-1) || 0,
        sma50: sma50Values.at(-1),
        sma200: sma200Values.at(-1),
        timestamp: Date.now(),
      };
    } catch (error) {
      return null;
    }
  }

  storeData(symbol, tf, candles) {
    if (!this.marketData[symbol]) this.marketData[symbol] = {};
    this.marketData[symbol][tf] = { candles: candles };
    this.marketData[symbol][tf].indicators = this.calculateTechnicalIndicators(
      symbol,
      tf
    );
  }

  getCompletePicture(symbol) {
    return this.marketData[symbol];
  }
}

module.exports = DataManager;
