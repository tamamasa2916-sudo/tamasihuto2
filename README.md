# 介護シフトプランナー

早番・遅番・日勤のシフトを自動生成する React アプリです。GitHub Pages でそのまま公開できるように構成しています。

## 公開手順（GitHub Actionsで自動デプロイ）

1. このフォルダの中身をそのまま新しい GitHub リポジトリに push します。

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
   git push -u origin main
   ```

2. GitHub のリポジトリ画面で **Settings → Pages** を開き、「Build and deployment」の **Source** を **GitHub Actions** に設定します。

3. `main` ブランチに push すると `.github/workflows/deploy.yml` が自動的に実行され、ビルドして GitHub Pages に公開されます（Actions タブで進行状況を確認できます）。

4. 数分後、`https://<あなたのユーザー名>.github.io/<リポジトリ名>/` でアクセスできるようになります。

## ローカルで動作確認したい場合

```bash
npm install
npm run dev
```

`http://localhost:5173` で確認できます。

## 手動でビルド・デプロイしたい場合（Actionsを使わない方法）

```bash
npm install
npm run build
npm run deploy
```

`npm run deploy` は `gh-pages` パッケージを使って `dist` フォルダを `gh-pages` ブランチに push します。この場合は GitHub の Pages 設定で Source を `gh-pages` ブランチに変更してください。

## ファイル構成

```
├── index.html
├── package.json
├── vite.config.js
├── .github/workflows/deploy.yml   … GitHub Actions での自動デプロイ設定
└── src/
    ├── main.jsx           … エントリーポイント
    └── ShiftPlanner.jsx   … シフト自動生成アプリ本体
```
