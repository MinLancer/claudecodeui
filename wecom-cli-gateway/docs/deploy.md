# 部署说明

## 前置
- Node.js 20+
- Redis(本机或外部)
- claude code CLI(已装,PATH 可用)
- claudecodeui(基座,独立运行,端口 3001)

## 启动网关
1. 复制 config.example.yaml 为 config.yaml,填企微凭证与 projectDir、Redis url
2. `npm install && npm run build`
3. `npm start`  (或 `npm run dev` 开发热重载)

## 公网接入(企微回调需公网 URL)
用 ngrok/frp/nginx 把 `https://你的域名/webhook/wecom/{botId}` 反代到本机 3002。

nginx 示例:
    location /webhook/ {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
    }

## 企微后台配置
- 回调 URL: https://你的域名/webhook/wecom/wecom_1
- Token / EncodingAESKey: 与 config.yaml 一致

## 验证
- 企微私聊机器人发"你好",应收到 claude 回复
- 群内 @机器人 发消息,机器人 @你 回复
- 不同人/不同群回复互不串话

## 共享 ~/.claude
网关与 claudecodeui 跑同一用户,共享 ~/.claude;企微产生的会话可在 claudecodeui web 端只读查看。
