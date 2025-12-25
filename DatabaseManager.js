const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initDatabase();
  }

  async initDatabase() {
    this.db = await open({
      filename: path.join(__dirname, "trading_system.sqlite"),
      driver: sqlite3.Database,
    });

    // إنشاء الجداول
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        timeframe TEXT NOT NULL,
        UNIQUE(symbol, timestamp, timeframe)
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT UNIQUE NOT NULL,
        symbol TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        entry_time DATETIME NOT NULL,
        exit_time DATETIME NOT NULL,
        pnl_percent REAL NOT NULL,
        pnl_usd REAL NOT NULL,
        confidence_score REAL NOT NULL,
        rsi_value REAL,
        volume_ratio REAL,
        whale_power INTEGER,
        reasons TEXT,
        stop_loss REAL,
        take_profit REAL,
        exit_reason TEXT,
        duration_seconds INTEGER
      );

      CREATE TABLE IF NOT EXISTS technical_indicators (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        rsi REAL,
        atr REAL,
        volume_ma_20 REAL,
        current_volume REAL,
        sma_50 REAL,
        sma_200 REAL,
        macd REAL,
        macd_signal REAL,
        macd_histogram REAL,
        bollinger_upper REAL,
        bollinger_middle REAL,
        bollinger_lower REAL,
        UNIQUE(symbol, timestamp)
      );

      CREATE TABLE IF NOT EXISTS whale_sightings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        whale_count INTEGER NOT NULL,
        largest_whale_value REAL,
        avg_whale_value REAL,
        positions TEXT,
        whale_power_score INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_candles_symbol_timeframe ON candles(symbol, timeframe);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol_time ON trades(symbol, exit_time);
      CREATE INDEX IF NOT EXISTS idx_indicators_symbol ON technical_indicators(symbol);
    `);
  }

  async saveCandle(symbol, candle, timeframe) {
    try {
      await this.db.run(
        `INSERT OR REPLACE INTO candles 
        (symbol, timestamp, open, high, low, close, volume, timeframe) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          symbol,
          new Date(candle[0]).toISOString(),
          candle[1], // open
          candle[2], // high
          candle[3], // low
          candle[4], // close
          candle[5], // volume
          timeframe,
        ]
      );
    } catch (error) {
      console.error("Error saving candle:", error);
    }
  }

  async getHistoricalCandles(symbol, timeframe, limit = 200) {
    try {
      return await this.db.all(
        `SELECT timestamp, open, high, low, close, volume 
         FROM candles 
         WHERE symbol = ? AND timeframe = ? 
         ORDER BY timestamp DESC 
         LIMIT ?`,
        [symbol, timeframe, limit]
      );
    } catch (error) {
      console.error("Error getting candles:", error);
      return [];
    }
  }

  async saveTrade(tradeData) {
    try {
      await this.db.run(
        `INSERT INTO trades 
        (trade_id, symbol, entry_price, exit_price, entry_time, exit_time, 
         pnl_percent, pnl_usd, confidence_score, rsi_value, volume_ratio, 
         whale_power, reasons, stop_loss, take_profit, exit_reason, duration_seconds) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tradeData.id,
          tradeData.symbol,
          tradeData.entryPrice,
          tradeData.exitPrice,
          new Date(tradeData.entryTime).toISOString(),
          new Date(tradeData.exitTime).toISOString(),
          tradeData.pnlPercent,
          tradeData.pnlUsd,
          tradeData.confidence,
          tradeData.rsiValue,
          tradeData.volumeRatio,
          tradeData.whalePower,
          tradeData.reasons,
          tradeData.stopLoss,
          tradeData.takeProfit,
          tradeData.exitReason,
          tradeData.duration,
        ]
      );
    } catch (error) {
      console.error("Error saving trade:", error);
    }
  }

  async getTradeStatistics(symbol = null) {
    try {
      let query = `
        SELECT 
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as winning_trades,
          SUM(CASE WHEN pnl_percent <= 0 THEN 1 ELSE 0 END) as losing_trades,
          AVG(pnl_percent) as avg_pnl_percent,
          SUM(pnl_usd) as total_pnl_usd,
          AVG(confidence_score) as avg_confidence,
          AVG(duration_seconds) as avg_duration
        FROM trades
      `;

      const params = [];
      if (symbol) {
        query += ` WHERE symbol = ?`;
        params.push(symbol);
      }

      return await this.db.get(query, params);
    } catch (error) {
      console.error("Error getting trade stats:", error);
      return null;
    }
  }

  async saveTechnicalIndicators(symbol, indicators) {
    try {
      await this.db.run(
        `INSERT OR REPLACE INTO technical_indicators 
        (symbol, timestamp, rsi, atr, volume_ma_20, current_volume, 
         sma_50, sma_200, macd, macd_signal, macd_histogram,
         bollinger_upper, bollinger_middle, bollinger_lower) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          symbol,
          new Date().toISOString(),
          indicators.rsi,
          indicators.atr,
          indicators.volumeMA20,
          indicators.currentVolume,
          indicators.sma50,
          indicators.sma200,
          indicators.macd,
          indicators.macdSignal,
          indicators.macdHistogram,
          indicators.bollingerUpper,
          indicators.bollingerMiddle,
          indicators.bollingerLower,
        ]
      );
    } catch (error) {
      console.error("Error saving indicators:", error);
    }
  }

  async getLatestIndicators(symbol, limit = 10) {
    try {
      return await this.db.all(
        `SELECT * FROM technical_indicators 
         WHERE symbol = ? 
         ORDER BY timestamp DESC 
         LIMIT ?`,
        [symbol, limit]
      );
    } catch (error) {
      console.error("Error getting indicators:", error);
      return [];
    }
  }

  async saveWhaleSighting(symbol, whaleData) {
    try {
      await this.db.run(
        `INSERT INTO whale_sightings 
        (symbol, timestamp, whale_count, largest_whale_value, 
         avg_whale_value, positions, whale_power_score) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          symbol,
          new Date().toISOString(),
          whaleData.count,
          whaleData.largestValue,
          whaleData.avgValue,
          JSON.stringify(whaleData.positions),
          whaleData.powerScore,
        ]
      );
    } catch (error) {
      console.error("Error saving whale sighting:", error);
    }
  }

  async getWhalePatterns(symbol, hours = 24) {
    try {
      return await this.db.all(
        `SELECT 
          AVG(whale_count) as avg_whales_per_hour,
          MAX(whale_count) as max_whales,
          AVG(largest_whale_value) as avg_largest_whale,
          COUNT(*) as sightings_count
         FROM whale_sightings 
         WHERE symbol = ? AND timestamp >= datetime('now', ?)
        `,
        [symbol, `-${hours} hours`]
      );
    } catch (error) {
      console.error("Error getting whale patterns:", error);
      return [];
    }
  }
  async cleanupOldData(daysToKeep = 2) {
    try {
      const cutOffDate = new Date();
      cutOffDate.setDate(cutOffDate.getDate() - daysToKeep);
      const dateString = cutOffDate.toISOString();

      // مسح الشموع القديمة
      const candleResult = await this.db.run(
        `DELETE FROM candles WHERE timestamp < ?`,
        [dateString]
      );

      // مسح المؤشرات الفنية القديمة
      const indicatorResult = await this.db.run(
        `DELETE FROM technical_indicators WHERE timestamp < ?`,
        [dateString]
      );

      // مسح سجلات الحيتان القديمة
      await this.db.run(`DELETE FROM whale_sightings WHERE timestamp < ?`, [
        dateString,
      ]);

      console.log(
        `🧹 تم تنظيف البيانات الأقدم من ${daysToKeep} يوم. (حذف ${candleResult.changes} شمعة)`
      );

      // أمر VACUUM لتقليص حجم ملف قاعدة البيانات فعلياً على القرص
      await this.db.run(`VACUUM`);
    } catch (error) {
      console.error("❌ خطأ أثناء تنظيف قاعدة البيانات:", error.message);
    }
  }
}

module.exports = DatabaseManager;
