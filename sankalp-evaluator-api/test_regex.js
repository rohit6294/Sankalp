const streams = [
  'B.E/B. Tech', 
  'B. Pharma', 
  'B.E/B.Tech (JEE(Main) Seats)', 
  'B.E/B.Tech/B.Arch (WBJEE) Seats)', 
  'B. Arch  (JEE(Main) Seats)', 
  'B.E/B.Tech (WBJEE/JEE(Main) Seats)/B.Arch (WBJEE Seats)'
]; 

streams.forEach(s => { 
  let c2 = s.replace(/\\/JEE\\(Main\\) Seats/g, '') // remove first
  console.log(c2);
});
