# Pi 拡張機能

Pi 向けの拡張機能と、動作確認・効果測定の記録をまとめた個人用リポジトリです。

## 拡張機能一覧

| 拡張機能 | 概要 | 詳細 |
|---|---|---|
| [`background-compaction`](background-compaction/) | 会話を続けながら古いアシスタント応答を非同期で要約します。モデルは保存済みの既定値、またはPiで選択中のものを使えます。 | [README](background-compaction/README.md) |

## テスト

リポジトリのルートで実行します。

```sh
npm test
```

## インストール

`background-compaction` を Pi のエージェント用ディレクトリ（既定値：`~/.pi/agent`）にインストールまたは更新します。

```sh
./background-compaction/install.sh
```

インストーラーは実行に必要なファイルだけを拡張機能ディレクトリへコピーし、Pi の設定を更新します。変更前の設定と拡張機能は、エージェント用ディレクトリの `backups/background-compaction/` に保存されます。

アンインストールする場合は、次を実行します。インストール済みのファイルはバックアップに移動します。

```sh
./background-compaction/install.sh --uninstall
```
