const Razorpay = require('razorpay');

async function test() {
  try {
    const rzp = new Razorpay({
      key_id: "invalid_key",
      key_secret: "invalid_secret",
    });

    const order = await rzp.orders.create({
      amount: 50000,
      currency: 'INR',
      receipt: 'test_receipt_123'
    });
    console.log("SUCCESS:", order);
  } catch (e) {
    console.error("e.message:", e.message);
    console.error("e.error:", e.error);
    console.error("ERROR OBJECT:", JSON.stringify(e, null, 2));
  }
}
test();
