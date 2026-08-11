# Contributing to pg-history

Thank you for your interest in contributing to our project! This guide will help you get started with the development process.

## Development Setup

### Prerequisites

- Bun installed on your system

### Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/TimMikeladze/pg-history.git`
3. Navigate to the project directory: `cd pg-history`
4. Install dependencies: `bun install`
5. Start development: `bun run dev`

## Development Workflow

1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Make your changes
3. Check and fix code style and formatting issues: `bun run lint:fix`
4. Run tests: `bun run test`
5. Build the project: `bun run build`
6. Commit your changes using the conventions below
7. Push your branch to your fork
8. Open a pull request

## The Landing Page

`site/` renders <https://pg-history.dev> from `README.md` at build time — `bun run dev` and `bun run build` from inside `site/`.

Its social card (`site/public/og.png`, what LinkedIn, X and Slack show when the link is shared) is a committed artifact, not a build output: it is rendered by a headless Chrome, which the deploy does not have. Regenerate it with `bun run og` from `site/` after changing the README tagline, the card copy in `site/og/build-og.ts`, or the dashboard screenshots in `site/public/shots/`, and commit the PNG alongside.

Both platforms cache a card per URL, so a freshly deployed image only shows up in new shares until the cache is cleared through [LinkedIn's Post Inspector](https://www.linkedin.com/post-inspector/) or [X's Card Validator](https://cards-dev.twitter.com/validator).

## Commit Message Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/) for clear and structured commit messages:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code changes that neither fix bugs nor add features
- `perf:` Performance improvements
- `test:` Adding or updating tests
- `chore:` Maintenance tasks, dependencies, etc.

## Pull Request Guidelines

1. Update documentation if needed
2. Ensure all tests pass
3. Address any feedback from code reviews
4. Once approved, your PR will be merged

## Code of Conduct

Please be respectful and constructive in all interactions within our community.

## Questions?

If you have any questions, please [open an issue](https://github.com/TimMikeladze/pg-history/issues/new) for discussion.

Thank you for contributing to pg-history!
