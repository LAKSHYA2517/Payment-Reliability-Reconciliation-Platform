import express from "express";

const app=express();

app.use(express.json());

app.get("/",(req,res)=>{
    res.json({
        message:"Payment API is running"
    });
});

app.get("/payment",(req,res)=>{
    const payment=req.body;
    
    res.json({
        message:"Payment recieved",
        payment
    });
});


app.listen(3000,()=>{
    console.log("Server is running on port 3000");
})
