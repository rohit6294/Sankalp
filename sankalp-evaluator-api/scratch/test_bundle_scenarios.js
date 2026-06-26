const path = require('path');
// Load environment variables from the local .env file
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { db } = require('../src/firebase');
const choiceFillingRouter = require('../src/routes/choice-filling');
const { userHasChoiceAccess } = choiceFillingRouter;

const TEST_UID = 'test_bundle_user_12345';
const TEST_REQ = {
  user: {
    uid: TEST_UID,
    email: 'test_bundle_student@example.com'
  }
};

async function cleanup() {
  console.log('Cleaning up mock test documents...');
  await db.collection('users').doc(TEST_UID).delete();
  await db.collection('purchases').doc(`${TEST_UID}_college_predictor`).delete();
  await db.collection('purchases').doc(`${TEST_UID}_choice_filling`).delete();
}

async function runTests() {
  console.log('=== STARTING BUNDLE SCENARIOS INTEGRATION TESTS ===');

  try {
    // 0. Ensure choice-filling is enabled and requires payment in settings
    console.log('Setting up mock settings...');
    await db.collection('settings').doc('college_predictor').set({
      choiceFillingEnabled: true,
      choiceFillingRequiresPayment: true,
      requiresPayment: true,
      choiceFillingMaxAttempts: 30
    }, { merge: true });

    let testsPassed = 0;
    let totalTests = 0;

    async function assertScenario(name, setupFunc, expected) {
      totalTests++;
      console.log(`\nTest Case ${totalTests}: ${name}`);
      
      // Clean up past state first
      await cleanup();
      
      // Run setup
      await setupFunc();

      // Run access check
      const result = await userHasChoiceAccess(TEST_REQ);
      
      // Assert
      const hasAccessMatch = result.hasAccess === expected.hasAccess;
      const unlimitedMatch = result.unlimited === expected.unlimited;
      const attemptsMatch = result.attemptsLeft === expected.attemptsLeft;

      if (hasAccessMatch && unlimitedMatch && attemptsMatch) {
        console.log(`✅ PASSED: returned hasAccess=${result.hasAccess}, unlimited=${result.unlimited}, attemptsLeft=${result.attemptsLeft}`);
        testsPassed++;
      } else {
        console.error(`❌ FAILED:`);
        console.error(`   Expected: hasAccess=${expected.hasAccess}, unlimited=${expected.unlimited}, attemptsLeft=${expected.attemptsLeft}`);
        console.error(`   Received: hasAccess=${result.hasAccess}, unlimited=${result.unlimited}, attemptsLeft=${result.attemptsLeft}`);
      }
    }

    // Scenario 1: Unpaid User (No Access)
    await assertScenario(
      'Brand new unpaid user (no access)',
      async () => {
        // Just empty, no setup needed
      },
      { hasAccess: false, unlimited: false, attemptsLeft: 0 }
    );

    // Scenario 2: User with predictorPurchased: true in user document
    await assertScenario(
      'User with predictorPurchased: true in user doc (should get free unlimited access)',
      async () => {
        await db.collection('users').doc(TEST_UID).set({
          predictorPurchased: true
        });
      },
      { hasAccess: true, unlimited: true, attemptsLeft: 9999 }
    );

    // Scenario 3: User with predictorUnlocked: true in user document
    await assertScenario(
      'User with predictorUnlocked: true in user doc (should get free unlimited access)',
      async () => {
        await db.collection('users').doc(TEST_UID).set({
          predictorUnlocked: true
        });
      },
      { hasAccess: true, unlimited: true, attemptsLeft: 9999 }
    );

    // Scenario 4: User with successful college_predictor purchase record in purchases collection
    await assertScenario(
      'User with successful college_predictor purchase document (should get free unlimited access)',
      async () => {
        await db.collection('purchases').doc(`${TEST_UID}_college_predictor`).set({
          userId: TEST_UID,
          product: 'college_predictor',
          status: 'success'
        });
      },
      { hasAccess: true, unlimited: true, attemptsLeft: 9999 }
    );

    // Scenario 5: User with legacy choice-filling attempts left
    await assertScenario(
      'User with legacy choice-filling attempts left (should get limited access)',
      async () => {
        await db.collection('users').doc(TEST_UID).set({
          choiceFillingAttemptsLeft: 5
        });
      },
      { hasAccess: true, unlimited: false, attemptsLeft: 5 }
    );

    // Scenario 6: User with legacy choice-filling unlimited access
    await assertScenario(
      'User with legacy choice-filling unlimited access',
      async () => {
        await db.collection('users').doc(TEST_UID).set({
          choiceFillingUnlimited: true
        });
      },
      { hasAccess: true, unlimited: true, attemptsLeft: 9999 }
    );

    // Scenario 7: User with successful legacy choice-filling purchase (auto-initialized)
    await assertScenario(
      'User with successful legacy choice-filling purchase (should auto-initialize to max attempts)',
      async () => {
        await db.collection('purchases').doc(`${TEST_UID}_choice_filling`).set({
          userId: TEST_UID,
          product: 'choice_filling',
          status: 'success'
        });
        await db.collection('users').doc(TEST_UID).set({
          choiceFillingUnlocked: true,
          choiceFillingAttemptsLeft: null
        });
      },
      { hasAccess: true, unlimited: false, attemptsLeft: 30 }
    );

    // Final Cleanup
    await cleanup();

    console.log(`\n=== TESTS SUMMARY: ${testsPassed} / ${totalTests} PASSED ===`);
    if (testsPassed === totalTests) {
      console.log('🎉 ALL BUNDLE ACCESS SCENARIO TESTS PASSED SUCCESSFULLY!');
      process.exit(0);
    } else {
      console.error('⚠️ SOME TESTS FAILED. PLEASE CHECK LOGS.');
      process.exit(1);
    }

  } catch (err) {
    console.error('Tests failed with error:', err);
    await cleanup();
    process.exit(1);
  }
}

runTests();
