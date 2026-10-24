name: Peter Football Tips Data Update

on:
  schedule:
    - cron: '0 5 * * *' # Automatically runs every day at 5:00 AM
  workflow_dispatch: # Allows you to manually trigger "Run workflow" anytime

permissions:
  contents: write
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  update-data:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Dependencies
        run: |
          if [ -f package.json ]; then npm install; fi

      - name: Run Probability Calculations Script
        env:
          FOOTBALL_API_KEY: ${{ secrets.FOOTBALL_API_KEY }}
        run: |
          node calculate_predictions.js

      - name: Upload Complete Project Assets
        uses: actions/upload-pages-artifact@v3
        with:
          path: '.'

  deploy-site:
    needs: update-data
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
