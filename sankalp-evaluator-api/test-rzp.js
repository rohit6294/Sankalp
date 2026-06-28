const Razorpay = require('razorpay');

async function test() {
  try {
    const rzp = new Razorpay({
      key_id: "rzp_test_SvaBuaHrLjK4u0",
      key_secret: "kjZtCIkGiHHYGA0MHPafRoEJ",
    });

    const order = await rzp.orders.create({
      amount: 50000,
      currency: 'INR',
      receipt: 'test_receipt_123'
    });
    console.log("SUCCESS:", order);
  } catch (e) {
    console.error("ERROR MESSAGE:", e.message);
    console.error("ERROR OBJECT:", JSON.stringify(e, null, 2));
  }
}
test();
