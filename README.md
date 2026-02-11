[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/ai)](https://api.reuse.software/info/github.com/cap-js/ai)

# ai

## About this project

_Insert a short description of your project here..._

## Requirements and Setup

_Insert a short description what is required to get your project running..._

## Tests

In `tests/bookshop/` you can find a sample application that is used to demonstrate how to use the plugin and to run tests against it.

### Local Testing

To execute local tests, simply run:

```bash
npm run test
```

For tests, the `cds-test` Plugin is used to spin up the application. More information about `cds-test` can be found [here](https://cap.cloud.sap/docs/node.js/cds-test).

### Hybrid Testing

#### Local

In the case of hybrid tests (i.e., tests that run with a real BTP service), you can bind the service instance to the local application like this:

```bash
cds bind -2 my-service
```

More on `cds bind` can be found [here](https://pages.github.tools.sap/cap/docs/advanced/hybrid-testing#cds-bind-usage)

The hybrid integration tests can be run via:

```bash
npm run test:hybrid
```

#### CI

For CI, the service binding is added during the action run. Uncomment the _Bind against BTP services_ and _BTP Auth_ sections in the file `.github/actions/integration-tests/action.yml` and adjust the service name/names accordingly. The `cds bind` command executed there will be the almost the same as done locally before, with the difference that it will be written to package.json in CI.

You can also execute the tests against a HANA Cloud instance. For that, add the commented sections in the action file and adjust accordingly.

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/<your-project>/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow our instructions at [in our security policy](https://github.com/cap-js/<your-project>/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2026 SAP SE or an SAP affiliate company and ai contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/<your-project>).
