module.exports = {
      PORT: process.env.PORT || 1300,
  WS_PORT: process.env.WS_PORT || 4000,
  // WhatsApp bug types
  BUGS: [
    { bug_id: "delay", bug_name: "DELAY X BULLDO" },
    { bug_id: "delay2", bug_name: "DELAY INVISIBLE" },
    { bug_id: "spam", bug_name: "CRASH ANDROID" },
    { bug_id: "crash", bug_name: "BLANK ANDROID" },
  //  { bug_id: "uix", bug_name: "CRASH X UI" },
 //   { bug_id: "bokep", bug_name: "FC NO CLICK COBA²"},
    { bug_id: "ios", bug_name: "CRASH IOS" },
  //  { bug_id: "fcnoinvis", bug_name: "FC CLICK ANDROID" }
  ],
    
  payload: [
    { bug_id: "invisibleSpam", bug_name: "DELAY ANDROID" },
    { bug_id: "forceCloseMentalVVIP", bug_name: "FORCE CLOSE" },
    { bug_id: "stealthCrashVVIP", bug_name: "CRASH ANDROID" },
    { bug_id: "crashNotificationVVIP", bug_name: "CRASH NOTIFIKASI" },
    { bug_id: "permenCall", bug_name: "PRANK CALL" }
  ],
    
  DDOS: [
    { ddos_id: "s-gbps", ddos_name: "SYN High GBPS" },
    { ddos_id: "s-pps", ddos_name: "SYN Traffic Flood" },
    { ddos_id: "a-gbps", ddos_name: "ACK High GBPS" },
    { ddos_id: "a-pps", ddos_name: "ACK Traffic Flood" },
    { ddos_id: "icmp", ddos_name: "ICMP Flood" },
    { ddos_id: "udp", ddos_name: "GUDP ( HIGH RISK )" }

  ],
  // News data
  NEWS: [
    {
      image: "https://files.catbox.moe/z44rld.gif",
      title: "NECROBYTE V12",
      desc: "keep growing as time goes by"
    },
    {
      image: "https://files.catbox.moe/qb4l1i.png",
      title: "UPDATE BUG",
      desc: "BLANK AND DELAY"
    }
  ],
  // Role cooldowns (in seconds)
  ROLE_COOLDOWNS: {
    member: 100,
    reseller: 140,
    reseller1: 60,
    owner: 0,
    vip: 60,
  },
  // Max quantities by role
  MAX_QUANTITIES: {
    member: 5,
    reseller: 5,
    reseller1: 5,
    owner: 10,
    vip: 10,
  }
};