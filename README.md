# cap-js Repository Template

Default templates for @cap-js open source [CAP Calesi](https://cap.cloud.sap/docs/about/best-practices#the-calesi-pattern) plugins. It includes a sample plugin and the basic setup needed to start with development. All repositories on github.com/cap-js will be created based on this template.

## To-Do

In case you are the maintainer of a new @cap-js open source CAP plugin, these are the steps to do with the template files:

- Check if the default license (Apache 2.0) also applies to your project. A license change should only be required in exceptional cases. If this is the case, please change it.
- Enter the correct metadata for the REUSE tool. Please replace the parts inside the single angle quotation marks < > by the specific information for your repository and be sure to run the REUSE tool to validate that the metadata is correct.
- Adjust the contribution guidelines (e.g. add coding style guidelines, pull request checklists, different license if needed etc.)
- Add information about your project to this README (name, description, requirements etc). Especially take care for the <your-project> placeholders - those ones need to be replaced with your project name. See the sections below the horizontal line.
- Setup your GitHub repository:
  - Add the GitHub protection rules for you repository:
    - Go to Settings > Rules > Rulesets > New ruleset > Import from json
    - Upload the file `gh_ruleset.json`. You can delete it in your repository afterwards
  - Add collaborators to your repository:
    - Maximilian Eckert (maxieckert-sap) as Admin
    - `cdsmunich`-Team as Maintainer
  - Create a label with the name `no changelog`. If you want to skip the check for changelog entries in your PR, you can add this label.
- Adjust the name of your plugin in the needed places (Search for `REPO-NAME` and replace it with your plugin name)
- Start developing your new CAP plugin!
  - Adjust the sample `cds-plugin.js` file
  - Adjust the sample service implementations in `lib`
  - Adjust the sample test application in `tests/bookshop` to show the usage of your plugin
- Remove all content in this README above and including the horizontal line ;)

---

# Our new open source project

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

Copyright (20xx-)20xx SAP SE or an SAP affiliate company and <your-project> contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/<your-project>).
