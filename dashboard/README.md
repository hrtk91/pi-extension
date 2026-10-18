# Dashboard

Pi のフッターにセッション情報を表示し、`/stats` で現在選択中のセッションbranchの応答統計を確認できる拡張機能です。

## インストール

```sh
./dashboard/install.sh
```

実行ファイルを `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/dashboard` にコピーし、`settings.json` の拡張機能設定を更新します。従来の `extensions/dashboard.js` がある場合は、設定を新しい配置先へ切り替えてバックアップします。変更前の設定・配置済みファイルは `backups/dashboard/` に保存します。

`PI_CODING_AGENT_DIR` でインストール先を変更できます。アンインストール時も実行ファイルはバックアップに残ります。集計キャッシュ `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/dashboard-stats.json` は拡張機能の更新・アンインストールでは削除されません。

```sh
./dashboard/install.sh --uninstall
```

## 機能

- フッターにモデル名、選択中branchの入出力token合計、`tok/s p50/p90`、キャッシュヒット率、コンテキスト残量、Git branchを表示
- `nvidia-smi` が使える環境ではVRAMとGPU温度も表示
- `/stats` で全セッションとprovider/model別の統計をタブ表示。TUIでは左右矢印またはTabで切り替え
- 統計には応答数、出力token数、`tok/s p50/p90`、平均応答時間、合算応答速度、セッション数を表示

`/stats` の初回実行時に `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions/` 配下の過去の `.jsonl` セッションを走査し、以後は変更されたファイルを再走査します。現在のセッションファイルも対象です。すべてのprojectと保存済みbranchにあるassistant応答を集計し、フォークで複製された同一応答は重複計上しません（statuslineは従来どおり現在選択中のbranchのみを表示）。保存するのはentry/session ID、provider/model、output token数、duration、timestampだけで、会話本文やプロンプトは保存しません。集計キャッシュはセッションログを削除した後も残ります。

`tok/s` は各assistant応答の `usage.output / durationMs` です。Piの `durationMs` は応答の開始から終了までなので、TTFTや通信待ちを含む応答全体の速度です。`usage.output` にはプロバイダーが報告するreasoning tokenが含まれる場合があります。`durationMs` のない旧形式・遅延取得応答、出力tokenが0の応答、およびprovider/modelを特定できない応答は速度統計から除外します。p50/p90は計測対象応答ごとの速度から算出します。

## テスト

リポジトリのルートで実行します。

```sh
npm test
```
