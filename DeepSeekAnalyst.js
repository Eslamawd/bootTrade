// DeepSeekAnalyst.js
const axios = require("axios");

class DeepSeekAnalyst {
  constructor() {
    this.apiKey = process.env.DEEPSEEK_API_KEY;
    this.baseURL = "https://api.deepseek.com";
    this.contextMemory = new Map(); // ذاكرة السياق لكل رمز
    this.analysisHistory = []; // سجل التحليلات للتعلم
  }

  async analyzeMarketSituation(
    symbol,
    marketData,
    decisionMatrix,
    tradeContext = null
  ) {
    try {
      // بناء الـ prompt الذكي
      const prompt = this.buildIntelligentPrompt(
        symbol,
        marketData,
        decisionMatrix,
        tradeContext
      );

      // جلب التحليل من DeepSeek
      const analysis = await this.getDeepSeekAnalysis(prompt);

      // معالجة وتحليل النتيجة
      const processedAnalysis = this.processAnalysis(analysis, symbol);

      // حفظ في الذاكرة للتعلم المستقبلي
      this.saveToMemory(symbol, processedAnalysis);

      return processedAnalysis;
    } catch (error) {
      console.error(
        `❌ DeepSeek analysis failed for ${symbol}:`,
        error.message
      );
      return this.getFallbackAnalysis();
    }
  }

  buildIntelligentPrompt(symbol, marketData, decisionMatrix, tradeContext) {
    const currentTime = new Date().toLocaleString("ar-SA");
    const previousAnalyses = this.contextMemory.get(symbol) || [];

    return `
        ## 🧠 تحليل سوق متعمق لـ ${symbol} ##
        
        ### 📊 البيانات الحالية ###
        الوقت: ${currentTime}
        السعر الحالي: ${marketData.currentPrice}
        RSI: ${decisionMatrix.indicators?.rsi || "N/A"}
        الحجم النسبي: ${decisionMatrix.indicators?.volumeRatio || "N/A"}x
        ATR: ${decisionMatrix.indicators?.atr || "N/A"}
        
        ### 📈 التحليل الفني ###
        ${this.formatTechnicalAnalysis(decisionMatrix)}
        
        ### 🐋 نشاط الحيتان ###
        ${this.formatWhaleAnalysis(decisionMatrix.whaleAnalysis)}
        
        ### 📉 Order Book Dynamics ###
        Imbalance: ${decisionMatrix.imbalanceAtEntry?.toFixed(2) || "N/A"}x
        Strong Wall: ${decisionMatrix.wallPrice || "N/A"}
        
        ### 📍 السياق الحالي ###
        ${
          tradeContext
            ? `نحن في صفقة نشطة: ${tradeContext.status}`
            : "بحث عن فرصة دخول"
        }
        
        ### 📚 التاريخ السابق ###
        ${
          previousAnalyses
            .slice(-3)
            .map((a) => `- ${a.summary}`)
            .join("\n") || "لا يوجد تاريخ"
        }
        
        ### ❓ الأسئلة الاستراتيجية ###
        1. ما هي نقاط القوة والضعف في الوضع الحالي؟
        2. ما هي احتمالية نجاح صفقة شراء الآن؟
        3. ما هي المخاطر غير المرئية؟
        4. ما هي التوصية المثلى (شراء/بيع/انتظار)؟
        5. ما هي الثقة في هذا التحليل من 0-100%؟
        
        ### 🎯 المخرجات المطلوبة ###
        يرجى الرد بالتنسيق التالي:
        التحليل: [تحليل مفصل]
        التوصية: [شراء/بيع/انتظار]
        الثقة: [0-100]%
        المخاطر: [منخفضة/متوسطة/عالية]
        الأسباب: [سبب1، سبب2، سبب3]
        التحذيرات: [إن وجدت]
        `;
  }

  async getDeepSeekAnalysis(prompt) {
    const response = await axios.post(
      `${this.baseURL}/chat/completions`,
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "أنت محلل أسواق مالية خبير متخصص في العملات المشفرة. قدم تحليلاً دقيقاً وواقعياً مع تقييم المخاطر.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 1500,
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content;
  }

  processAnalysis(rawAnalysis, symbol) {
    // استخراج المعلومات المنظمة من النص
    const analysis = {
      symbol,
      timestamp: Date.now(),
      raw: rawAnalysis,
      parsed: this.parseAnalysisText(rawAnalysis),
      confidence: this.extractConfidence(rawAnalysis),
      recommendation: this.extractRecommendation(rawAnalysis),
      risks: this.extractRisks(rawAnalysis),
      summary: this.generateSummary(rawAnalysis),
    };

    return analysis;
  }

  parseAnalysisText(text) {
    // تحليل النص لاستخراج المعلومات المنظمة
    const patterns = {
      recommendation: /التوصية:\s*(شراء|بيع|انتظار)/i,
      confidence: /الثقة:\s*(\d+)%/i,
      risks: /المخاطر:\s*(منخفضة|متوسطة|عالية)/i,
    };

    const result = {};
    for (const [key, pattern] of Object.entries(patterns)) {
      const match = text.match(pattern);
      if (match) result[key] = match[1];
    }

    return result;
  }

  saveToMemory(symbol, analysis) {
    if (!this.contextMemory.has(symbol)) {
      this.contextMemory.set(symbol, []);
    }

    const history = this.contextMemory.get(symbol);
    history.push(analysis);

    // حفظ آخر 20 تحليل فقط
    if (history.length > 20) {
      history.shift();
    }

    // حفظ في سجل التحليلات
    this.analysisHistory.push({
      symbol,
      ...analysis,
      timestamp: new Date().toISOString(),
    });
  }

  formatTechnicalAnalysis(decisionMatrix) {
    const ind = decisionMatrix.indicators || {};
    return `
        • RSI: ${ind.rsi?.toFixed(1) || "N/A"} (${this.getRSIStatus(ind.rsi)})
        • Volume Ratio: ${ind.volumeRatio?.toFixed(1) || "N/A"}x
        • ATR: $${ind.atr?.toFixed(4) || "N/A"} (${
      ((ind.atr / ind.close) * 100)?.toFixed(2) || "N/A"
    }%)
        • Trend: ${this.getTrendStatus(ind)}
        • Price Position: ${
          ind.pricePosition?.toFixed(1) || "N/A"
        }% (من نطاق 24h)
        `;
  }

  formatWhaleAnalysis(whaleAnalysis) {
    if (!whaleAnalysis || !whaleAnalysis.whales)
      return "لا توجد بيانات عن الحيتان";

    const whales = whaleAnalysis.whales;
    return `
        • عدد الحيتان النشطة: ${whales.length}
        • أقوى حوت: $${whales[0]?.value?.toFixed(0) || "N/A"}
        • قوة الحيتان: ${whaleAnalysis.score} نقطة
        ${
          whaleAnalysis.warnings?.length > 0
            ? `• تحذيرات: ${whaleAnalysis.warnings.join(", ")}`
            : ""
        }
        `;
  }

  getRSIStatus(rsi) {
    if (rsi < 30) return "تشبع بيعي قوي";
    if (rsi < 40) return "تشبع بيعي";
    if (rsi < 60) return "محايد";
    if (rsi < 70) return "تشبع شرائي";
    return "تشبع شرائي قوي";
  }

  getTrendStatus(indicators) {
    if (!indicators.sma50 || !indicators.sma200) return "غير محدد";

    if (
      indicators.close > indicators.sma50 &&
      indicators.sma50 > indicators.sma200
    )
      return "صاعد قوي";
    if (indicators.close > indicators.sma50) return "صاعد";
    if (
      indicators.close < indicators.sma50 &&
      indicators.sma50 < indicators.sma200
    )
      return "هابط قوي";
    return "هابط";
  }

  extractConfidence(text) {
    const match = text.match(/الثقة:\s*(\d+)%/i);
    return match ? parseInt(match[1]) : 50;
  }

  extractRecommendation(text) {
    const match = text.match(/التوصية:\s*(شراء|بيع|انتظار)/i);
    return match ? match[1].toLowerCase() : "انتظار";
  }

  extractRisks(text) {
    const match = text.match(/المخاطر:\s*(منخفضة|متوسطة|عالية)/i);
    return match ? match[1] : "متوسطة";
  }

  generateSummary(text) {
    // استخراج جملة موجزة من التحليل
    const lines = text
      .split("\n")
      .filter(
        (line) =>
          line.includes("التحليل:") ||
          line.includes("توصية:") ||
          line.includes("سبب:")
      );

    return lines.slice(0, 2).join(" ") || "تحليل شامل للسوق";
  }

  getFallbackAnalysis() {
    return {
      parsed: {
        recommendation: "انتظار",
        confidence: 50,
        risks: "متوسطة",
      },
      summary: "تحليل احتياطي - تعذر الاتصال بـ DeepSeek",
    };
  }

  // دالة لتحليل أداء التحليلات السابقة
  async evaluatePastAnalyses() {
    const evaluations = [];

    for (const analysis of this.analysisHistory.slice(-50)) {
      // هنا يمكنك إضافة منطق لتقييم دقة التحليلات السابقة
      // مقارنة التوصيات مع حركة السوق الفعلية
    }

    return evaluations;
  }
}

module.exports = DeepSeekAnalyst;
