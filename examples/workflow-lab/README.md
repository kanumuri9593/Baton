# A two-project workflow you can actually run

No dependencies beyond Node 24+ and Baton. The API and browser console are separate project roots, processes and sessions.

From the Baton repository:

```bash
node src/cli/index.ts workflow examples/workflow-lab/workflow.json
```

Or with Baton installed, from this folder:

```bash
baton workflow workflow.json
```

Open the Console URL returned by the command. Click **Complete delivery**. Verify **Delivered**, a receipt number, and the disabled completion button. Refresh the page: the API retains the receipt. **Reset demo** clears it; the next delivery gets a new receipt.

To reproduce a failure and recovery:

```bash
baton stop api/delivery-api
# In the browser, click Refresh status: Service unavailable should appear.
baton logs console/delivery-console -n 5
baton restart api/delivery-api
baton wait api/delivery-api --until url
# Click Refresh status again: Ready should appear.
```

Demo state is in memory and resets when the API process restarts. Everything binds to loopback. Ports 43121 and 43122 must be free; change PORT in each launch configuration and API_URL in the console configuration together to use other ports.

Stop only this demo when finished:

```bash
baton stop api/delivery-api
baton stop console/delivery-console
baton forget api/delivery-api
baton forget console/delivery-console
```

The launcher refuses duplicate live sessions. Stop and forget previous demo sessions before running the workflow file again, or restart the existing sessions while iterating.

Run an independent Test environment alongside Local:

```bash
baton workflow workflow-test.json
```

Its console is returned on port 43132, with its own API on 43131. The page must show **Test lab**. Completing a Local delivery must not change the Test delivery's state. Stop the Test sessions with the exact IDs returned by that workflow.

Both Node projects enable `batonTrace`. In the HUD, open **Diagnose**, check **Include successful requests**, and search `delivery`. **Follow trace** shows the console's incoming request, its outgoing API fetch, and the API handler together. No external telemetry service is required.
