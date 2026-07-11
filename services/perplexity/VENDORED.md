# Vendored: perplexity-ai

来源 https://github.com/escapeWu/perplexity-ai (fork of https://github.com/ESousa97/perplexity-ai, MIT)。
作为 FusionSearch 的第 6 个搜索源内置:Perplexity 逆向封装(Pro 账号 cookie → OpenAI 兼容答案)。
只 vendorize 核心 Python 包(perplexity/ + perplexity_async/),不含前端 build 与 driver/playwright(可选、未启用)。
token 配置(账号 cookie)绝不入库,运行时经 HF Secret 注入。
